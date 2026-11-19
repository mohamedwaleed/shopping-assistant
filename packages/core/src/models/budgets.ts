// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type CoreError, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";
import type {
  BudgetAllowanceInput,
  BudgetGrant,
  BudgetLimits,
  BudgetPause,
  BudgetPool,
  BudgetPoolView,
  BudgetRequest,
  BudgetReservation,
  Budgets,
  BudgetUsage,
  BudgetUsageView,
  CostEstimate,
  SaveBudgetAllowance,
  SettleReservation,
} from "./budget-types";
import { BUDGET_POOLS } from "./budget-types";
import type { ResolvedModel } from "./types";

export interface BudgetDependencies {
  db: Knex;
  /** Resolves the model a reservation is granted for; core's own registry. */
  resolveModel: (principal: Principal) => Promise<Result<ResolvedModel>>;
  now?: () => Date;
}

/**
 * Starting allowances, to be calibrated (spec, Spending). Interactive work is
 * what a shopper waits for; background monitoring is scheduled and much
 * cheaper per run, so it gets its own, smaller pool.
 */
export const DEFAULT_INTERACTIVE_ALLOWANCE: BudgetLimits = {
  maxCalls: 60,
  maxTokens: 120_000,
  maxCents: 500,
};
export const DEFAULT_BACKGROUND_ALLOWANCE: BudgetLimits = {
  maxCalls: 20,
  maxTokens: 40_000,
  maxCents: 150,
};
export const DEFAULT_ALLOWANCES: Record<BudgetPool, BudgetLimits> = {
  interactive: DEFAULT_INTERACTIVE_ALLOWANCE,
  background: DEFAULT_BACKGROUND_ALLOWANCE,
};

/** Hard ceilings: no configuration, workspace or administrator, goes past these. */
export const MAX_ALLOWANCE: BudgetLimits = {
  maxCalls: 1_000,
  maxTokens: 2_000_000,
  maxCents: 10_000,
};

/**
 * A reservation nobody settles would hold its allowance forever. It expires
 * after this long and stops counting against the pool; the unit of work it
 * belonged to has already failed by then.
 */
export const RESERVATION_TTL_SECONDS = 300;

/** Retries of one unit of work are charged at most this many times. */
export const MAX_BUDGET_ATTEMPTS = 3;

/** One allowance window; both pools roll over independently. */
export const BUDGET_WINDOW_HOURS = 24;

/** Context assumed per call when a caller supplies no estimate. */
const DEFAULT_PROMPT_TOKENS = 2_000;
const DEFAULT_OUTPUT_TOKENS = 512;
const DEFAULT_CENTS_PER_CALL = 5;

/**
 * Conservative cost estimate used where no exact pre-call price exists. Every
 * assumption errs high: the whole context is counted as input, the whole output
 * allowance as produced, and nothing is assumed to be cached or free.
 */
export function estimateCallCost(estimate?: Partial<CostEstimate>): CostEstimate {
  return {
    tokens: estimate?.tokens ?? DEFAULT_PROMPT_TOKENS + DEFAULT_OUTPUT_TOKENS,
    cents: estimate?.cents ?? DEFAULT_CENTS_PER_CALL,
    basis: "estimated",
  };
}

export const ESTIMATE_ASSUMPTION =
  "Pre-call prices are not published for every provider, so each call is charged the higher of its " +
  "conservative estimate and what the provider reports, and every retry is charged again.";

/**
 * Validate an allowance and clamp it to the hard ceilings. A caller asking for
 * more than the installation allows is not an error: it is stored clamped, so
 * what is recorded is never more than what can be spent.
 */
function clampAllowance(input: BudgetAllowanceInput): BudgetLimits | null {
  const values = [input.maxCalls, input.maxTokens, input.maxCents];
  if (!values.every((value) => Number.isInteger(value) && value >= 0)) return null;
  return {
    maxCalls: Math.min(input.maxCalls, MAX_ALLOWANCE.maxCalls),
    maxTokens: Math.min(input.maxTokens, MAX_ALLOWANCE.maxTokens),
    maxCents: Math.min(input.maxCents, MAX_ALLOWANCE.maxCents),
  };
}

/** Per unit, the smaller of the override and the ceiling: never a sum. */
function effectiveLimits(ceiling: BudgetLimits, override: BudgetLimits | null): BudgetLimits {
  if (!override) return ceiling;
  return {
    maxCalls: Math.min(override.maxCalls, ceiling.maxCalls),
    maxTokens: Math.min(override.maxTokens, ceiling.maxTokens),
    maxCents: Math.min(override.maxCents, ceiling.maxCents),
  };
}

function isClamped(override: BudgetLimits | null, effective: BudgetLimits): boolean {
  if (!override) return false;
  return (
    override.maxCalls !== effective.maxCalls ||
    override.maxTokens !== effective.maxTokens ||
    override.maxCents !== effective.maxCents
  );
}

function limitsOf(row: {
  max_calls: number;
  max_tokens: number;
  max_cents: number;
} | undefined): BudgetLimits | null {
  if (!row) return null;
  return { maxCalls: row.max_calls, maxTokens: row.max_tokens, maxCents: row.max_cents };
}

interface AllowanceRow {
  max_calls: number;
  max_tokens: number;
  max_cents: number;
}

interface PeriodRow {
  id: string;
  workspace_id: string;
  pool: BudgetPool;
  window_started_at: Date;
}

interface UsageRow {
  pool: BudgetPool;
  calls: string | number | null;
  tokens: string | number | null;
  cents: string | number | null;
  in_flight: string | number | null;
}

function number(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : Number(value);
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function exhausted(pause: BudgetPause): CoreError {
  return {
    kind: "budget-exhausted",
    pool: pause.pool,
    reason: pause.reason,
    ...(pause.unit ? { unit: pause.unit } : {}),
    ...(pause.limit !== undefined ? { limit: pause.limit } : {}),
    ...(pause.used !== undefined ? { used: pause.used } : {}),
  };
}

/**
 * The budget engine. Every allowance decision is made inside one PostgreSQL
 * transaction that locks the period row with SELECT ... FOR UPDATE, so two
 * concurrent callers are serialized and the last unit of an allowance is
 * handed out exactly once. No in-memory lock could do that across processes.
 */
export function createBudgets(deps: BudgetDependencies): Budgets {
  const { db, resolveModel } = deps;
  const now = deps.now ?? (() => new Date());

  function admittedWorkspace(principal: Principal): Result<string> {
    if (principal.kind === "anonymous" || !isAuthorized(principal, "workspace.read")) {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    if (!uuid(principal.workspaceId)) {
      return err({
        kind: "invalid-input",
        field: "workspaceId",
        message: "workspaceId must be a UUID",
      });
    }
    return ok(principal.workspaceId);
  }

  async function membershipWorkspace(principal: Principal): Promise<Result<string>> {
    const workspaceId = admittedWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    if (principal.kind === "anonymous") return err({ kind: "forbidden", capability: "workspace.read" });
    const membership = await db("workspace_memberships")
      .where({ workspace_id: workspaceId.value, user_id: principal.userId })
      .first();
    if (!membership) return err({ kind: "forbidden", capability: "workspace.read" });
    return workspaceId;
  }

  async function installationCeilings(): Promise<Record<BudgetPool, BudgetLimits>> {
    const rows = (await db("budget_allowances")
      .where({ scope: "installation" })
      .select("pool", "max_calls", "max_tokens", "max_cents")) as Array<
      AllowanceRow & { pool: BudgetPool }
    >;
    const ceilings = { ...DEFAULT_ALLOWANCES };
    for (const row of rows) {
      ceilings[row.pool] = limitsOf(row)!;
    }
    return ceilings;
  }

  async function workspaceOverrides(
    workspaceId: string,
  ): Promise<Record<BudgetPool, BudgetLimits | null>> {
    const rows = (await db("budget_allowances")
      .where({ scope: "workspace", workspace_id: workspaceId })
      .select("pool", "max_calls", "max_tokens", "max_cents")) as Array<
      AllowanceRow & { pool: BudgetPool }
    >;
    const overrides: Record<BudgetPool, BudgetLimits | null> = { interactive: null, background: null };
    for (const row of rows) {
      overrides[row.pool] = limitsOf(row);
    }
    return overrides;
  }

  async function permission(workspaceId: string): Promise<{
    mayOverride: boolean;
    paidFallbackAllowed: boolean;
  }> {
    const row = await db("workspace_budget_permissions").where({ workspace_id: workspaceId }).first();
    return {
      mayOverride: row?.may_override === true,
      paidFallbackAllowed: row?.may_allow_paid_fallback === true,
    };
  }

  async function consent(workspaceId: string): Promise<boolean> {
    const row = await db("workspace_personal_key_consents").where({ workspace_id: workspaceId }).first();
    return row?.background_allowed === true;
  }

  /** Usage of every settled and still-reserved row in the current window. */
  async function usageFor(
    workspaceId: string,
    period: PeriodRow,
  ): Promise<BudgetUsage> {
    const [row] = (await db("budget_reservations")
      .where({ period_id: period.id })
      .where((query) =>
        query.where("status", "settled").orWhere((live) =>
          live.where("status", "reserved").andWhere("expires_at", ">", now()),
        ),
      )
      .select(
        db.raw("coalesce(sum(reserved_calls), 0) as calls"),
        db.raw("coalesce(sum(coalesce(actual_tokens, reserved_tokens)), 0) as tokens"),
        db.raw("coalesce(sum(coalesce(actual_cents, reserved_cents)), 0) as cents"),
        db.raw("coalesce(sum(case when status = 'reserved' then 1 else 0 end), 0) as in_flight"),
      )) as UsageRow[];
    return {
      calls: number(row?.calls),
      tokens: number(row?.tokens),
      cents: number(row?.cents),
      inFlightCalls: number(row?.in_flight),
    };
  }

  /**
   * The current window for a workspace and pool. Created lazily and anchored
   * once, so every caller in the window reads the same period.
   */
  async function currentPeriod(
    trx: Knex,
    workspaceId: string,
    pool: BudgetPool,
  ): Promise<PeriodRow> {
    const current = now();
    const windowMs = BUDGET_WINDOW_HOURS * 60 * 60 * 1000;
    const anchor = new Date(
      Math.floor(current.getTime() / windowMs) * windowMs,
    );
    await trx("budget_periods")
      .insert({
        workspace_id: workspaceId,
        pool,
        window_started_at: anchor,
        created_at: current,
        updated_at: current,
      })
      .onConflict(["workspace_id", "pool", "window_started_at"])
      .ignore();
    const row = (await trx("budget_periods")
      .where({ workspace_id: workspaceId, pool, window_started_at: anchor })
      .first()) as PeriodRow;
    return row;
  }

  function windowOf(period: PeriodRow): { startedAt: string; endsAt: string } {
    const startedAt = new Date(period.window_started_at).getTime();
    return {
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + BUDGET_WINDOW_HOURS * 60 * 60 * 1000).toISOString(),
    };
  }

  /** The first unit that has no room left, if any. */
  function pauseFor(
    pool: BudgetPool,
    limits: BudgetLimits,
    usage: BudgetUsage,
  ): BudgetPause | null {
    if (usage.calls >= limits.maxCalls) {
      return { pool, reason: "calls-exhausted", unit: "calls", limit: limits.maxCalls, used: usage.calls };
    }
    if (usage.tokens >= limits.maxTokens) {
      return { pool, reason: "tokens-exhausted", unit: "tokens", limit: limits.maxTokens, used: usage.tokens };
    }
    if (usage.cents >= limits.maxCents) {
      return { pool, reason: "spend-exhausted", unit: "cents", limit: limits.maxCents, used: usage.cents };
    }
    return null;
  }

  async function view(workspaceId: string): Promise<BudgetUsageView> {
    const ceilings = await installationCeilings();
    const overrides = await workspaceOverrides(workspaceId);
    const allowed = await permission(workspaceId);
    const pools: BudgetPoolView[] = [];
    for (const pool of BUDGET_POOLS) {
      const override = allowed.mayOverride ? overrides[pool] : null;
      const effective = effectiveLimits(ceilings[pool], override);
      const period = await currentPeriod(db, workspaceId, pool);
      const usage = await usageFor(workspaceId, period);
      pools.push({
        pool,
        installation: ceilings[pool],
        workspace: override,
        effective,
        clamped: isClamped(override, effective),
        usage,
        window: windowOf(period),
        paused: pauseFor(pool, effective, usage),
      });
    }
    return {
      workspaceId,
      pools,
      consent: { backgroundPersonalKey: await consent(workspaceId) },
      fallback: { paidAllowed: false, workspaceMayRequest: allowed.paidFallbackAllowed },
      estimates: {
        basis: "conservative",
        assumption: ESTIMATE_ASSUMPTION,
        defaults: DEFAULT_ALLOWANCES.interactive,
        ceilings: MAX_ALLOWANCE,
      },
    };
  }

  async function read(principal: Principal): Promise<Result<BudgetUsageView>> {
    const workspaceId = await membershipWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    return ok(await view(workspaceId.value));
  }

  /**
   * The workspace an allowance change applies to. Anyone may act on their own
   * workspace; naming another one is an installation-level action, so it needs
   * the administrator role and the membership is still checked here.
   */
  async function targetWorkspace(
    principal: Principal,
    requested: string | undefined,
  ): Promise<Result<string>> {
    const own = await membershipWorkspace(principal);
    if (!own.ok) return own;
    if (requested === undefined || requested === own.value) return own;
    if (!isAuthorized(principal, "installation.manage")) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }
    if (!uuid(requested)) {
      return err({ kind: "invalid-input", field: "workspaceId", message: "workspaceId must be a UUID" });
    }
    const exists = await db("workspaces").where({ id: requested }).first("id");
    if (!exists) return err({ kind: "not-found", resource: "workspace", id: requested });
    return ok(requested);
  }

  /**
   * Store an allowance. The installation row is the ceiling and only an
   * administrator may set it. A workspace row is a request that is clamped to
   * the ceiling on the way in, so an override can lower an allowance but can
   * never raise it past the installation's limit — and it is only applied at
   * all once the administrator has allowed overrides.
   */
  async function saveAllowance(
    principal: Principal,
    input: SaveBudgetAllowance,
  ): Promise<Result<BudgetUsageView>> {
    const workspaceId = await targetWorkspace(principal, input.workspaceId);
    if (!workspaceId.ok) return workspaceId;
    const current = now();

    const installationLimits = input.installation ? clampAllowance(input.installation) : null;
    if (input.installation && !installationLimits) {
      return err({
        kind: "invalid-input",
        field: "installation",
        message: "allowance must be whole, non-negative numbers within the installation ceilings",
      });
    }
    const workspaceLimits =
      input.workspace && typeof input.workspace === "object" ? clampAllowance(input.workspace) : null;
    if (input.workspace && typeof input.workspace === "object" && !workspaceLimits) {
      return err({
        kind: "invalid-input",
        field: "workspace",
        message: "allowance must be whole, non-negative numbers within the installation ceilings",
      });
    }

    const managesInstallation = isAuthorized(principal, "installation.manage");
    const managesPermissions =
      input.workspaceOverrideAllowed !== undefined || input.paidFallbackAllowed !== undefined;
    // The ceiling and the permission to override it are installation state, so
    // only an administrator may touch them. A workspace may otherwise set its
    // own allowance, clamped to whatever the administrator permitted.
    if (!managesInstallation && (input.installation || managesPermissions)) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }

    await db.transaction(async (trx) => {
      if (input.installation && installationLimits) {
        await trx("budget_allowances")
          .where({ scope: "installation", pool: input.installation.pool })
          .delete();
        await trx("budget_allowances").insert({
          scope: "installation",
          workspace_id: null,
          pool: input.installation.pool,
          max_calls: installationLimits.maxCalls,
          max_tokens: installationLimits.maxTokens,
          max_cents: installationLimits.maxCents,
          updated_at: current,
        });
      }
      if (managesPermissions) {
        // Each permission is merged on its own: granting one must not silently
        // reset the other, which a whole-row merge would do.
        const existing = await trx("workspace_budget_permissions")
          .where({ workspace_id: workspaceId.value })
          .first();
        await trx("workspace_budget_permissions")
          .insert({
            workspace_id: workspaceId.value,
            may_override: input.workspaceOverrideAllowed ?? existing?.may_override ?? false,
            may_allow_paid_fallback:
              input.paidFallbackAllowed ?? existing?.may_allow_paid_fallback ?? false,
            updated_at: current,
          })
          .onConflict("workspace_id")
          .merge();
      }
      if (input.workspace === null) {
        await trx("budget_allowances")
          .where({ scope: "workspace", workspace_id: workspaceId.value })
          .delete();
        return;
      }
      if (!workspaceLimits || !input.workspace || typeof input.workspace !== "object") return;
      const ceiling = (await installationCeilings())[input.workspace.pool];
      // Clamped against the ceiling that applies right now, not just the hard
      // maximum, so a stored override is never above what may be spent.
      const stored = effectiveLimits(ceiling, workspaceLimits);
      await trx("budget_allowances")
        .where({
          scope: "workspace",
          workspace_id: workspaceId.value,
          pool: input.workspace.pool,
        })
        .delete();
      await trx("budget_allowances").insert({
        scope: "workspace",
        workspace_id: workspaceId.value,
        pool: input.workspace.pool,
        max_calls: stored.maxCalls,
        max_tokens: stored.maxTokens,
        max_cents: stored.maxCents,
        updated_at: current,
      });
    });
    return ok(await view(workspaceId.value));
  }

  async function setPersonalKeyBackgroundConsent(
    principal: Principal,
    allowed: boolean,
  ): Promise<Result<BudgetUsageView>> {
    const workspaceId = await membershipWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    const current = now();
    await db("workspace_personal_key_consents")
      .insert({
        workspace_id: workspaceId.value,
        background_allowed: allowed,
        consented_by_user_id: principal.kind === "anonymous" ? null : principal.userId,
        consented_at: allowed ? current : null,
        updated_at: current,
      })
      .onConflict("workspace_id")
      .merge();
    return ok(await view(workspaceId.value));
  }

  /**
   * Reserve one call before contacting a provider. Consent and fallback gates
   * run before any locking, then a single transaction locks the period row,
   * recomputes usage and either writes the reservation or reports the pause.
   */
  async function reserve(
    principal: Principal,
    request: BudgetRequest,
  ): Promise<Result<BudgetGrant>> {
    const workspaceId = await membershipWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;

    const resolved = await resolveModel(principal);
    if (!resolved.ok) return resolved;

    // A personal key on background work is the shopper's own money spent while
    // nobody is watching: it needs explicit consent, and without it the work
    // pauses rather than silently moving to the installation account.
    if (
      request.pool === "background" &&
      resolved.value.usageSource === "workspace" &&
      !(await consent(workspaceId.value))
    ) {
      return err({ kind: "budget-consent-required", pool: "background" });
    }

    const attempt = request.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_BUDGET_ATTEMPTS) {
      return err({ kind: "budget-retry-exhausted", attempts: MAX_BUDGET_ATTEMPTS });
    }

    const ceilings = await installationCeilings();
    const allowed = await permission(workspaceId.value);
    const overrides = await workspaceOverrides(workspaceId.value);
    const override = allowed.mayOverride ? overrides[request.pool] : null;
    const effective = effectiveLimits(ceilings[request.pool], override);
    const estimate = estimateCallCost(request.estimate);
    const current = now();

    const outcome = await db.transaction(async (trx) => {
      const period = await currentPeriod(trx, workspaceId.value, request.pool);
      // Serializes every concurrent reservation for this workspace and pool.
      // The second caller blocks here until the first has committed, so it sees
      // the first reservation and cannot spend the same unit twice.
      const locked = await trx("budget_periods")
        .where({ id: period.id })
        .forUpdate()
        .first();
      if (!locked) {
        return { kind: "missing-period" as const };
      }
      const usage = await usageFor(workspaceId.value, period);
      const pause = pauseFor(request.pool, effective, usage);
      if (pause) return { kind: "paused" as const, pause };

      const [row] = (await trx("budget_reservations")
        .insert({
          period_id: period.id,
          pool: request.pool,
          usage_source: resolved.value.usageSource,
          reserved_calls: 1,
          reserved_tokens: estimate.tokens,
          reserved_cents: estimate.cents,
          status: "reserved",
          attempt,
          retry_of: request.retryOf ?? null,
          created_at: current,
          expires_at: new Date(current.getTime() + RESERVATION_TTL_SECONDS * 1000),
        })
        .returning("id")) as Array<{ id: string }>;
      return { kind: "granted" as const, id: row!.id, period };
    });

    if (outcome.kind === "paused") {
      return err(exhausted(outcome.pause));
    }
    if (outcome.kind === "missing-period") {
      return err({ kind: "invalid-input", field: "pool", message: "unknown budget pool" });
    }

    return ok({
      model: resolved.value,
      reservation: {
        id: outcome.id,
        workspaceId: workspaceId.value,
        pool: request.pool,
        usageSource: resolved.value.usageSource,
        reserved: estimate,
        actual: null,
        status: "reserved",
        attempt,
        expiresAt: new Date(current.getTime() + RESERVATION_TTL_SECONDS * 1000).toISOString(),
      },
    });
  }

  /** Lock the reservation and its period, so settlement is serialized too. */
  async function lockReservation(
    trx: Knex,
    reservationId: string,
  ): Promise<{ row: Record<string, unknown>; period: PeriodRow } | null> {
    const row = (await trx("budget_reservations")
      .where({ id: reservationId })
      .forUpdate()
      .first()) as Record<string, unknown> | undefined;
    if (!row) return null;
    const period = (await trx("budget_periods")
      .where({ id: row.period_id as string })
      .forUpdate()
      .first()) as PeriodRow | undefined;
    if (!period) return null;
    // The period names the owning workspace; the reservation row does not, so
    // the scope check happens before this lock is taken.
    return { row: { ...row, workspace_id: period.workspace_id }, period };
  }

  function reservationOf(row: Record<string, unknown>): BudgetReservation {
    const actual =
      row.actual_tokens === null && row.actual_cents === null
        ? null
        : {
            tokens: number(row.actual_tokens as number | null),
            cents: number(row.actual_cents as number | null),
            basis: "reported" as const,
          };
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      pool: row.pool as BudgetPool,
      usageSource: row.usage_source as BudgetReservation["usageSource"],
      reserved: {
        tokens: number(row.reserved_tokens as number),
        cents: number(row.reserved_cents as number),
        basis: "estimated",
      },
      actual,
      status: row.status as BudgetReservation["status"],
      attempt: number(row.attempt as number),
      expiresAt: new Date(row.expires_at as Date).toISOString(),
    };
  }

  async function reservationFor(
    principal: Principal,
    reservationId: string,
  ): Promise<Result<{ row: Record<string, unknown> }>> {
    const workspaceId = await membershipWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    const row = await db("budget_reservations as r")
      .join("budget_periods as p", "p.id", "r.period_id")
      .where("r.id", reservationId)
      .where("p.workspace_id", workspaceId.value)
      .select("r.*", "p.workspace_id")
      .first();
    if (!row) return err({ kind: "not-found", resource: "budget-reservation", id: reservationId });
    return ok({ row });
  }

  /**
   * Record what a call actually used. The charge is the higher of the
   * conservative estimate and what the provider reported, so an under-reported
   * usage figure can never buy back allowance; the difference stays charged.
   */
  async function settle(
    principal: Principal,
    input: SettleReservation,
  ): Promise<Result<BudgetReservation>> {
    const existing = await reservationFor(principal, input.reservationId);
    if (!existing.ok) return existing;
    if (existing.value.row.status !== "reserved") {
      return err({
        kind: "budget-reservation-invalid",
        reservationId: input.reservationId,
        state: String(existing.value.row.status),
      });
    }
    const settled = await db.transaction(async (trx) => {
      const locked = await lockReservation(trx, input.reservationId);
      if (!locked) return null;
      if (locked.row.status !== "reserved") return null;
      const tokens = Math.max(
        number(locked.row.reserved_tokens as number),
        input.actual?.tokens ?? 0,
      );
      const cents = Math.max(
        number(locked.row.reserved_cents as number),
        input.actual?.cents ?? 0,
      );
      const [row] = (await trx("budget_reservations")
        .where({ id: input.reservationId })
        .update({
          status: "settled",
          actual_tokens: tokens,
          actual_cents: cents,
          settled_at: now(),
        })
        .returning("*")) as Array<Record<string, unknown>>;
      return { ...row!, workspace_id: locked.period.workspace_id };
    });
    if (!settled) {
      return err({
        kind: "budget-reservation-invalid",
        reservationId: input.reservationId,
        state: "settled",
      });
    }
    return ok(reservationOf(settled));
  }

  /**
   * Release a reservation for a call that never reached the provider (a
   * cancellation before dispatch). A released call costs nothing; a call that
   * did reach the provider must be settled instead, which is what makes a
   * cancellation after dispatch still count.
   */
  async function release(
    principal: Principal,
    reservationId: string,
  ): Promise<Result<BudgetReservation>> {
    const existing = await reservationFor(principal, reservationId);
    if (!existing.ok) return existing;
    if (existing.value.row.status !== "reserved") {
      return err({
        kind: "budget-reservation-invalid",
        reservationId,
        state: String(existing.value.row.status),
      });
    }
    const released = await db.transaction(async (trx) => {
      const locked = await lockReservation(trx, reservationId);
      if (!locked || locked.row.status !== "reserved") return null;
      const [row] = (await trx("budget_reservations")
        .where({ id: reservationId })
        .update({
          status: "released",
          reserved_calls: 0,
          reserved_tokens: 0,
          reserved_cents: 0,
          actual_tokens: 0,
          actual_cents: 0,
          settled_at: now(),
        })
        .returning("*")) as Array<Record<string, unknown>>;
      return row!;
    });
    if (!released) {
      return err({ kind: "budget-reservation-invalid", reservationId, state: "settled" });
    }
    return ok(reservationOf(released));
  }

  return { read, saveAllowance, setPersonalKeyBackgroundConsent, reserve, settle, release };
}
