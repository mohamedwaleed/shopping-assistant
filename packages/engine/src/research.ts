import { randomUUID } from "node:crypto";
import type { Database } from "@shopping-assistant/database";
import { NotAnAdminError, PolicyRefusedError, type Actor } from "./accounts.ts";

/**
 * The allowance a research run works within, in cents and milliseconds. Every
 * value is an estimate of cost, not a bill: the adapters that spend money
 * reserve against these before each call and settle to what the call actually
 * cost afterwards.
 */
export interface ResearchLimits {
  /** What one run is expected to spend before it stops on its own. */
  runTargetCents: number;
  /** What one conversation may spend across every run it has had. */
  conversationCeilingCents: number;
  /** What one shopper may spend in a calendar day, across every conversation. */
  dailyCeilingCents: number;
  /** External calls one run may make: model, retrieval, retry, and fallback alike. */
  callLimit: number;
  /** Wall-clock time one run may take. */
  timeLimitMs: number;
}

/**
 * The application's own default. The operator may narrow these per deployment.
 * They are deliberately conservative: a run that overspends cannot be undone,
 * while one that stops early can be continued.
 */
export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  runTargetCents: 50,
  conversationCeilingCents: 200,
  dailyCeilingCents: 500,
  callLimit: 12,
  timeLimitMs: 90_000,
};

/** What the operator's environment allows an admin to raise the limits to. */
export type ResearchCeilings = Partial<ResearchLimits>;

export type ResearchRunState = "running" | "paused" | "stopped" | "completed";

/**
 * Why a run is no longer working. The shopper's own pause and the limits are
 * kept apart so a shopper is told which allowance was reached, and so a pause
 * can never be mistaken for a failure.
 */
export type ResearchPauseReason =
  | "shopper"
  | "run_target"
  | "conversation_ceiling"
  | "daily_ceiling"
  | "call_limit"
  | "time_limit";

/** What a call was for, so usage can be read without any conversation content. */
export type UsageCallKind = "model" | "retrieval" | "retry" | "fallback";

/** Raised when a run is not in a state that permits the requested change. */
export class ResearchRunStateError extends Error {
  constructor(reason: string) {
    super(`The research run cannot do that: ${reason}`);
    this.name = "ResearchRunStateError";
  }
}

/** Raised for both unknown runs and other shoppers' runs, so neither is revealed. */
export class ResearchRunNotFoundError extends Error {
  constructor() {
    super("Research run not found");
    this.name = "ResearchRunNotFoundError";
  }
}

/**
 * Raised when an allowance is exhausted. The reason says which one, because a
 * shopper told the daily ceiling was reached can come back tomorrow, while one
 * told only "no" cannot tell that from a fault.
 */
export class ResearchAllowanceExhaustedError extends Error {
  readonly reason: ResearchPauseReason;
  constructor(reason: ResearchPauseReason) {
    super(`The research allowance is exhausted: ${reason}`);
    this.name = "ResearchAllowanceExhaustedError";
    this.reason = reason;
  }
}

/** Raised when a reservation names a call that has already been accounted for. */
export class UsageReservationRefusedError extends Error {
  constructor(reason: string) {
    super(`Usage reservation refused: ${reason}`);
    this.name = "UsageReservationRefusedError";
  }
}

/**
 * How a call is priced: a rate per unit, and how many units it expects to use,
 * so the conservative estimate is `units * unitCents`. A call with no price is
 * not free: it is recorded as unknown, which still counts against the call and
 * time limits and marks the totals as incomplete.
 */
export interface CallPricing {
  /** Cents per unit of work; absent when the deployment has no price for it. */
  unitCents?: number;
  /** Units the caller expects to use; one unit when not stated. */
  units?: number;
}

export interface UsageReservation {
  /** Chosen by the caller, so a retried request is recognised as the same call. */
  reference?: string;
  callKind: UsageCallKind;
  pricing: CallPricing;
  /** The caller's own estimate of how long the call may take. */
  estimatedDurationMs?: number;
}

export interface UsageReservationRecord {
  id: string;
  runId: string;
  reference: string;
  callKind: UsageCallKind;
  /** What was held from every allowance for this call. */
  reservedCents: number;
  /** Whether the deployment knew a price for this call. */
  priced: boolean;
}

/** A settled or released call, and what it cost. */
export interface UsageSettlement {
  reservationId: string;
  /** Cents the call actually cost; absent when its price is unknown. */
  actualCents?: number;
  /** The call's own measurement of how long it took. */
  durationMs?: number;
}

export interface ResearchUsage {
  /** Cents held for calls that are in flight. */
  reservedCents: number;
  /** Cents already spent by settled calls. */
  spentCents: number;
  /** Calls started, whether settled, released, or still in flight. */
  calls: number;
  /** Time the run has been allowed to work, from its own accounting. */
  durationMs: number;
  /** True when any call's price was unknown, so the money figures are a floor. */
  costIncomplete: boolean;
}

export interface ResearchRun {
  id: string;
  conversationId: string;
  state: ResearchRunState;
  /** Why it is paused or stopped; absent while it has never been interrupted. */
  pauseReason: ResearchPauseReason | undefined;
  startedAt: Date;
  endedAt: Date | undefined;
  /** The limits this run was started with, which a later policy cannot rewrite. */
  limits: ResearchLimits;
  /** How many results the run had collected when it was last read. */
  resultsRetained: number;
  usage: ResearchUsage;
}

/** What one shopper may still spend today, and whether the figure is complete. */
export interface DailyAllowance {
  ceilingCents: number;
  /** Everything spent and held today, across every conversation. */
  usedCents: number;
  remainingCents: number;
  /** True when part of today's usage could not be priced. */
  costIncomplete: boolean;
}

/**
 * Aggregate usage for an administrator: totals only. Nothing here carries a
 * conversation's title, its messages, or its requirements, so an operator can
 * account for spending without reading anything a shopper wrote.
 */
export interface UsageOverview {
  calls: Record<UsageCallKind, number>;
  /** Cents spent by settled calls across the installation. */
  spentCents: number;
  /** Cents held for calls still in flight. */
  reservedCents: number;
  /** True when any installation usage could not be priced. */
  costIncomplete: boolean;
  byUser: { userId: string; calls: number; spentCents: number; costIncomplete: boolean }[];
  byConversation: { conversationId: string; calls: number; spentCents: number }[];
  /** Runs by state, so an operator can see what is in flight. */
  runs: Record<ResearchRunState, number>;
}

/** The administrator's own limits, and the most they may be raised to. */
export interface ResearchPolicy {
  limits: ResearchLimits;
  ceilings: ResearchLimits;
  updatedAt: Date | undefined;
}

export interface Research {
  /** The limits new runs start with, after the operator's ceiling. */
  limits(): Promise<ResearchLimits>;
  /** Admins only: the current limits and the most they may be raised to. */
  policy(actor: Actor): Promise<ResearchPolicy>;
  /**
   * Admins only: raises or lowers the limits. A value above the operator's
   * ceiling is refused rather than silently clamped, so an admin is never told
   * a limit applies that does not.
   */
  updatePolicy(actor: Actor, change: Partial<ResearchLimits>): Promise<ResearchPolicy>;
  /**
   * Starts a run on one of the caller's conversations. Refused when the
   * conversation has already spent its ceiling or the shopper has already
   * spent today's allowance: a run that could never make a call would be a
   * promise the engine cannot keep.
   */
  start(userId: string, conversationId: string): Promise<ResearchRun>;
  /** Pauses a running run for the shopper, keeping everything it collected. */
  pause(userId: string, runId: string): Promise<ResearchRun>;
  /** Ends a run for good. It keeps its results and its usage; it cannot resume. */
  stop(userId: string, runId: string): Promise<ResearchRun>;
  /**
   * Resumes a paused run as the same run: the same conversation, the same
   * conversation usage, the same daily usage, and the same limits.
   * Continuation deliberately starts nothing fresh, so pausing cannot be used
   * to reset an allowance.
   */
  continue(userId: string, runId: string): Promise<ResearchRun>;
  /** A run the caller owns, with its usage. */
  get(userId: string, runId: string): Promise<ResearchRun>;
  /** The caller's runs on one conversation, most recent first. */
  list(userId: string, conversationId: string): Promise<ResearchRun[]>;
  /** Records results a run has collected, so a pause or stop retains them. */
  recordResults(userId: string, runId: string, count: number): Promise<ResearchRun>;
  /** What the caller may still spend today. */
  dailyAllowance(userId: string): Promise<DailyAllowance>;
  /**
   * Holds an allowance for one call before it is made. The reservation is
   * atomic against every shared limit, so two concurrent runs near a limit
   * cannot both be allowed the last unit.
   */
  reserve(
    userId: string,
    runId: string,
    reservation: UsageReservation,
  ): Promise<UsageReservationRecord>;
  /** Records what a reserved call actually cost, releasing any difference. */
  settle(userId: string, settlement: UsageSettlement): Promise<ResearchRun>;
  /** Gives back a reservation whose call was never made. */
  release(userId: string, reservationId: string): Promise<ResearchRun>;
  /** Admins only: installation-wide totals, with no conversation content. */
  usage(actor: Actor): Promise<UsageOverview>;
}

/** Anything that can build a query: the database itself or an open transaction. */
type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

interface RunRow {
  id: string;
  conversation_id: string;
  user_id: string;
  state: ResearchRunState;
  pause_reason: ResearchPauseReason | null;
  started_at: Date;
  ended_at: Date | null;
  run_target_cents: string;
  conversation_ceiling_cents: string;
  daily_ceiling_cents: string;
  call_limit: number;
  time_limit_ms: number;
  /** Time already spent working, carried across every continuation. */
  elapsed_ms: string;
  /** When the current stretch of work began; null while the run is not working. */
  resumed_at: Date | null;
  results_retained: number;
}

const RUN_COLUMNS = [
  "id",
  "conversation_id",
  "user_id",
  "state",
  "pause_reason",
  "started_at",
  "ended_at",
  "run_target_cents",
  "conversation_ceiling_cents",
  "daily_ceiling_cents",
  "call_limit",
  "time_limit_ms",
  "elapsed_ms",
  "resumed_at",
  "results_retained",
] as const;

/**
 * One key for the whole installation's research accounting. Every reservation
 * reads three allowances — the run, its conversation, and the shopper's day —
 * and only then writes, so two reservations that each fit alone but not
 * together would both pass if they only locked the run. Taking one
 * installation-wide lock before reading anything serialises them: the second
 * sees the first's reservation and is refused the unit it cannot afford.
 *
 * It is transaction-scoped, so it is released at commit or rollback and an
 * abandoned request cannot leave the allowance locked. It serialises research
 * accounting only: starting a conversation, reading one, or changing accounts
 * never takes it.
 */
const RESEARCH_USAGE_LOCK = 5_054_002;

/**
 * What a ledger row counts towards, in cents. Written once here so that every
 * aggregate — the run, its conversation, the shopper's day, the installation —
 * answers the same question the same way, and a reserved call counts exactly
 * as much as the settled amount it will become.
 *
 * A reservation holds its estimate. A release gives the whole estimate back. A
 * settlement gives back the estimate and then charges what the call cost, or
 * keeps the estimate when the price turned out to be unknown. Because the
 * released estimate is always subtracted, the sum over every row is exact and
 * cannot go negative through rounding.
 */
const LEDGER_CENTS = `
  CASE
    WHEN kind = 'reserve' THEN estimated_cents
    WHEN kind = 'release' THEN -estimated_cents
    WHEN kind = 'settle' THEN -estimated_cents + coalesce(actual_cents, estimated_cents)
    ELSE 0
  END
`;

/** Cents spent by calls that are finished, which is what a report shows. */
const SPENT_CENTS = `
  CASE WHEN kind = 'settle' THEN coalesce(actual_cents, estimated_cents) ELSE 0 END
`;

/** A price that was not known anywhere in the rows being summed. */
const PRICE_UNKNOWN = `bool_or(NOT priced)`;

function cents(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/** A price is known only when the rate is stated; the units default to one. */
function isPriced(pricing: CallPricing): boolean {
  return typeof pricing.unitCents === "number" && Number.isFinite(pricing.unitCents);
}

/** The conservative estimate: the stated rate for every unit the call may use. */
function estimateOf(pricing: CallPricing): number {
  if (!isPriced(pricing)) return 0;
  const unitCents = pricing.unitCents ?? 0;
  return unitCents * (pricing.units ?? 1);
}

/**
 * The limits after the operator's ceiling. A ceiling restricts, so it can only
 * lower a value; with none configured the application's default stands, exactly
 * as the model list does.
 */
function withinCeilings(limits: ResearchLimits, ceilings: ResearchCeilings): ResearchLimits {
  // A ceiling is written out per limit rather than looped over: a generic
  // lookup would read each key off a `Partial`, and a missing one has to mean
  // "no restriction" explicitly rather than by accident.
  return {
    runTargetCents: lowest(limits.runTargetCents, ceilings.runTargetCents),
    conversationCeilingCents: lowest(
      limits.conversationCeilingCents,
      ceilings.conversationCeilingCents,
    ),
    dailyCeilingCents: lowest(limits.dailyCeilingCents, ceilings.dailyCeilingCents),
    callLimit: lowest(limits.callLimit, ceilings.callLimit),
    timeLimitMs: lowest(limits.timeLimitMs, ceilings.timeLimitMs),
  };
}

/** The tighter of a limit and its ceiling; an absent ceiling restricts nothing. */
function lowest(limit: number, ceiling: number | undefined): number {
  // The ceiling is what the operator pays for, so an admin may reach it but not
  // pass it: a ceiling below the application's default narrows it, and one
  // above it is the most the deployment is prepared to spend.
  return ceiling === undefined ? limit : ceiling;
}

/** The start of the calendar day `now` falls in, in UTC, so days have no gaps. */
function dayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function createResearch({
  database,
  ceilings = {},
  now = () => new Date(),
  startedAt = now(),
}: {
  database: Database;
  /** What the deployment allows an admin to raise the limits to. */
  ceilings?: ResearchCeilings;
  /** The clock, so the daily and time ceilings are tested without waiting. */
  now?: () => Date;
  /** When a run records that it started; the engine's own start by default. */
  startedAt?: Date;
}): Research {
  /** The most an admin may set, which is also what new runs start with. */
  const operatorLimits = withinCeilings(DEFAULT_RESEARCH_LIMITS, ceilings);

  async function isAdmin(actor: Actor): Promise<boolean> {
    const admin = await database("profiles")
      .where({ id: actor.id, role: "admin", disabled: false })
      .first("id");
    return admin !== undefined;
  }

  async function requireAdmin(actor: Actor): Promise<void> {
    if (!(await isAdmin(actor))) throw new NotAnAdminError();
  }

  /**
   * The limits in force now: the admin's choice where there is one, and the
   * operator's ceiling everywhere else. A stored value above the ceiling cannot
   * occur — `updatePolicy` refuses it — but it is clamped on read anyway, so
   * narrowing the environment takes effect immediately.
   */
  async function currentLimits(connection: Queryable = database): Promise<ResearchLimits> {
    const installation = await connection("installation").first<{
      research_run_target_cents: string | null;
      research_conversation_ceiling_cents: string | null;
      research_daily_ceiling_cents: string | null;
      research_call_limit: number | null;
      research_time_limit_ms: number | null;
    }>([
      "research_run_target_cents",
      "research_conversation_ceiling_cents",
      "research_daily_ceiling_cents",
      "research_call_limit",
      "research_time_limit_ms",
    ]);
    const chosen: ResearchLimits = {
      runTargetCents:
        installation?.research_run_target_cents === null ||
        installation?.research_run_target_cents === undefined
          ? operatorLimits.runTargetCents
          : cents(installation.research_run_target_cents),
      conversationCeilingCents:
        installation?.research_conversation_ceiling_cents === null ||
        installation?.research_conversation_ceiling_cents === undefined
          ? operatorLimits.conversationCeilingCents
          : cents(installation.research_conversation_ceiling_cents),
      dailyCeilingCents:
        installation?.research_daily_ceiling_cents === null ||
        installation?.research_daily_ceiling_cents === undefined
          ? operatorLimits.dailyCeilingCents
          : cents(installation.research_daily_ceiling_cents),
      callLimit: installation?.research_call_limit ?? operatorLimits.callLimit,
      timeLimitMs: installation?.research_time_limit_ms ?? operatorLimits.timeLimitMs,
    };
    return withinCeilings(chosen, ceilings);
  }

  async function requireOwnedRun(userId: string, runId: string): Promise<RunRow> {
    const row = await database("research_runs")
      .where({ id: runId, user_id: userId })
      .first<RunRow>([...RUN_COLUMNS]);
    // An unknown run and another shopper's run answer the same way, so a run id
    // cannot be used to learn that someone else's research exists.
    if (!row) throw new ResearchRunNotFoundError();
    return row;
  }

  /**
   * The ledger's view of one run, which is the only source of what it used.
   * Working time is what earlier continuations used plus what the calls in
   * flight are estimated to take, so a slow call counts against the time limit
   * while it is still running rather than only once it is settled.
   */
  async function usageOf(
    run: RunRow,
    connection: Queryable = database,
  ): Promise<ResearchUsage> {
    const row = await connection("usage_events")
      .where({ run_id: run.id })
      .select(
        connection.raw(`coalesce(sum(${LEDGER_CENTS}), 0) AS held_cents`),
        connection.raw(`coalesce(sum(${SPENT_CENTS}), 0) AS spent_cents`),
        connection.raw(`count(*) FILTER (WHERE kind = 'reserve') AS calls`),
        connection.raw(
          // Cast to integer: a bigint arrives as a string, and a string plus a
          // number would concatenate rather than add.
          `coalesce(sum(CASE WHEN kind = 'reserve' THEN duration_ms ELSE 0 END), 0)::integer AS in_flight_ms`,
        ),
        connection.raw(`coalesce(${PRICE_UNKNOWN}, false) AS cost_incomplete`),
      )
      .first<{
        held_cents: string;
        spent_cents: string;
        calls: string;
        in_flight_ms: string;
        cost_incomplete: boolean;
      }>();
    const spentCents = cents(row?.spent_cents);
    const heldCents = cents(row?.held_cents);
    // Time already banked, plus this stretch since it resumed, plus what the
    // calls in flight are estimated to take: a slow call counts against the
    // limit while it runs, not only once it settles.
    const sinceResume = run.resumed_at ? Math.max(0, now().getTime() - run.resumed_at.getTime()) : 0;
    return {
      // Whatever is held but not yet spent is reserved: a call in flight.
      reservedCents: Math.max(0, heldCents - spentCents),
      spentCents,
      calls: cents(row?.calls),
      durationMs: cents(run.elapsed_ms) + sinceResume + cents(row?.in_flight_ms),
      costIncomplete: row?.cost_incomplete === true,
    };
  }

  /** Everything a run has committed: what it spent and what it is holding. */
  function committed(usage: ResearchUsage): number {
    return usage.spentCents + usage.reservedCents;
  }

  async function toRun(row: RunRow, connection: Queryable = database): Promise<ResearchRun> {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      state: row.state,
      pauseReason: row.pause_reason ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      limits: {
        runTargetCents: cents(row.run_target_cents),
        conversationCeilingCents: cents(row.conversation_ceiling_cents),
        dailyCeilingCents: cents(row.daily_ceiling_cents),
        callLimit: row.call_limit,
        timeLimitMs: row.time_limit_ms,
      },
      resultsRetained: row.results_retained,
      usage: await usageOf(row, connection),
    };
  }

  /**
   * The run, locked for the rest of the transaction. `FOR UPDATE` serialises
   * two requests on the same run even if they somehow bypassed the advisory
   * lock, and it is what makes "read the run, decide, write" safe.
   */
  async function lockedRun(transaction: Queryable, userId: string, runId: string): Promise<RunRow> {
    const rows = await transaction("research_runs")
      .where({ id: runId, user_id: userId })
      .forUpdate()
      .select<RunRow[]>([...RUN_COLUMNS]);
    const row = rows[0];
    if (!row) throw new ResearchRunNotFoundError();
    return row;
  }

  /**
   * Runs `work` in one transaction that first takes the research lock, so every
   * read of an allowance and every write that spends it are serialised against
   * each other across the installation.
   */
  async function inResearchTransaction<Result>(
    work: (transaction: Queryable) => Promise<Result>,
  ): Promise<Result> {
    return database.transaction(async (transaction) => {
      // Waiting is bounded so a lock held by an abandoned transaction turns
      // into a prompt refusal rather than a request that hangs forever.
      await transaction.raw("SET LOCAL lock_timeout = '10s'");
      await transaction.raw("SELECT pg_advisory_xact_lock(?)", [RESEARCH_USAGE_LOCK]);
      return work(transaction);
    });
  }

  async function appendEvent(
    transaction: Queryable,
    runId: string,
    kind: "start" | "pause" | "resume" | "stop" | "complete",
    reason: ResearchPauseReason | null,
  ): Promise<void> {
    await transaction("research_run_events").insert({
      run_id: runId,
      kind,
      reason,
      created_at: now(),
    });
  }

  async function saveRun(
    transaction: Queryable,
    runId: string,
    change: {
      state?: ResearchRunState;
      pauseReason?: ResearchPauseReason | null;
      endedAt?: Date | null;
      elapsedMs?: number;
      resumedAt?: Date | null;
      resultsRetained?: number;
    },
  ): Promise<RunRow> {
    const rows = await transaction("research_runs")
      .where({ id: runId })
      .update({
        ...(change.state === undefined ? {} : { state: change.state }),
        ...(change.pauseReason === undefined ? {} : { pause_reason: change.pauseReason }),
        ...(change.endedAt === undefined ? {} : { ended_at: change.endedAt }),
        ...(change.elapsedMs === undefined ? {} : { elapsed_ms: Math.round(change.elapsedMs) }),
        ...(change.resumedAt === undefined ? {} : { resumed_at: change.resumedAt }),
        ...(change.resultsRetained === undefined
          ? {}
          : { results_retained: change.resultsRetained }),
        updated_at: now(),
      })
      .returning<RunRow[]>([...RUN_COLUMNS]);
    const row = rows[0];
    if (!row) throw new ResearchRunNotFoundError();
    return row;
  }

  /** Cents spent and held today, across every conversation the shopper has. */
  async function dailyUsage(
    connection: Queryable,
    userId: string,
  ): Promise<{ usedCents: number; costIncomplete: boolean }> {
    const row = await connection("usage_events")
      .where({ user_id: userId })
      .where("created_at", ">=", dayStart(now()))
      .select(
        connection.raw(`coalesce(sum(${LEDGER_CENTS}), 0) AS used_cents`),
        connection.raw(`coalesce(${PRICE_UNKNOWN}, false) AS cost_incomplete`),
      )
      .first<{ used_cents: string; cost_incomplete: boolean }>();
    return { usedCents: cents(row?.used_cents), costIncomplete: row?.cost_incomplete === true };
  }

  /**
   * Cents spent and held on one conversation, across every run it has had, so
   * continuing a run cannot reset what the conversation has already used.
   */
  async function conversationUsage(
    connection: Queryable,
    conversationId: string,
  ): Promise<{ usedCents: number; costIncomplete: boolean }> {
    const row = await connection("usage_events")
      .where({ conversation_id: conversationId })
      .select(
        connection.raw(`coalesce(sum(${LEDGER_CENTS}), 0) AS used_cents`),
        connection.raw(`coalesce(${PRICE_UNKNOWN}, false) AS cost_incomplete`),
      )
      .first<{ used_cents: string; cost_incomplete: boolean }>();
    return { usedCents: cents(row?.used_cents), costIncomplete: row?.cost_incomplete === true };
  }

  /**
   * Pauses a run at the limit it reached, recording why. It writes on its own
   * connection because the refusal that follows rolls the caller's transaction
   * back: the call is refused, but the limit really was reached, so the reason
   * must survive. The write is guarded on the run still running, so two
   * refusals that arrive together record one pause rather than two.
   */
  async function pauseForLimit(runId: string, reason: ResearchPauseReason): Promise<void> {
    await database.transaction(async (transaction) => {
      const rows = await transaction("research_runs")
        .where({ id: runId, state: "running" })
        .forUpdate()
        .select<RunRow[]>([...RUN_COLUMNS]);
      const run = rows[0];
      if (!run) return;
      const working = run.resumed_at
        ? Math.max(0, now().getTime() - run.resumed_at.getTime())
        : 0;
      await saveRun(transaction, run.id, {
        state: "paused",
        pauseReason: reason,
        elapsedMs: cents(run.elapsed_ms) + working,
        resumedAt: null,
      });
      await appendEvent(transaction, run.id, "pause", reason);
    });
  }

  /**
   * The limit a settled call has brought the run to, if any. A settlement can
   * be the call that exhausts an allowance, so the run is paused in the same
   * transaction as the settlement: the shopper is told as soon as the limit is
   * reached rather than on the next attempt, and the pause commits with it.
   */
  async function exhaustedReason(
    transaction: Queryable,
    run: RunRow,
  ): Promise<ResearchPauseReason | undefined> {
    const usage = await usageOf(run, transaction);
    if (usage.calls >= run.call_limit) return "call_limit";
    if (committed(usage) >= cents(run.run_target_cents)) return "run_target";
    const conversation = await conversationUsage(transaction, run.conversation_id);
    if (conversation.usedCents >= cents(run.conversation_ceiling_cents)) {
      return "conversation_ceiling";
    }
    // Working time, which is what a settlement can also exhaust: a call that
    // took the whole allowance ends the run even if nothing else was spent.
    if (usage.durationMs >= run.time_limit_ms) return "time_limit";
    const day = await dailyUsage(transaction, run.user_id);
    return day.usedCents >= cents(run.daily_ceiling_cents) ? "daily_ceiling" : undefined;
  }

  interface ReservationRow {
    id: string;
    run_id: string;
    reference: string;
    call_kind: UsageCallKind;
    estimated_cents: string;
    priced: boolean;
  }

  /**
   * The reservation a settlement or release refers to, and the proof that it
   * belongs to the caller. Answering not-found for someone else's reservation
   * keeps reservations as private as the runs they belong to.
   */
  async function reservationOf(
    transaction: Queryable,
    userId: string,
    reservationId: string,
  ): Promise<ReservationRow> {
    const row = await transaction("usage_events")
      .where({ id: reservationId, kind: "reserve", user_id: userId })
      .first<ReservationRow>([
        "id",
        "run_id",
        "reference",
        "call_kind",
        "estimated_cents",
        "priced",
      ]);
    if (!row) throw new ResearchRunNotFoundError();
    // A reservation is spent once: a retried settlement must not count the same
    // call twice, so the second attempt is refused by name.
    const closed = await transaction("usage_events")
      .where({ reservation_id: row.id })
      .whereIn("kind", ["settle", "release"])
      .first("id");
    if (closed) throw new UsageReservationRefusedError("that call is already accounted for");
    return row;
  }

  async function dailyAllowance(userId: string): Promise<DailyAllowance> {
    const limits = await currentLimits();
    const used = await dailyUsage(database, userId);
    return {
      ceilingCents: limits.dailyCeilingCents,
      usedCents: used.usedCents,
      remainingCents: Math.max(0, limits.dailyCeilingCents - used.usedCents),
      costIncomplete: used.costIncomplete,
    };
  }

  return {
    limits: currentLimits,

    async policy(actor) {
      await requireAdmin(actor);
      const installation = await database("installation").first<{
        research_updated_at: Date | null;
      }>(["research_updated_at"]);
      return {
        limits: await currentLimits(),
        ceilings: operatorLimits,
        updatedAt: installation?.research_updated_at ?? undefined,
      };
    },

    async updatePolicy(actor, change) {
      // A ceiling restricts, so an override above it is refused outright rather
      // than clamped: an admin told a limit is in force must actually have it.
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) continue;
        const limit = key as keyof ResearchLimits;
        if (!Number.isFinite(value) || value < 0) {
          throw new PolicyRefusedError("research limits must be positive numbers");
        }
        if (value > operatorLimits[limit]) {
          throw new PolicyRefusedError(`the deployment allows at most ${operatorLimits[limit]}`);
        }
      }
      // The admin predicate is part of the write, so an admin demoted while this
      // request was in flight cannot still change the limits.
      const rows = await database("installation")
        .where({ id: 1 })
        .whereRaw(
          "EXISTS (SELECT 1 FROM profiles WHERE id = ? AND role = 'admin' AND NOT disabled)",
          [actor.id],
        )
        .update({
          ...(change.runTargetCents === undefined
            ? {}
            : { research_run_target_cents: change.runTargetCents }),
          ...(change.conversationCeilingCents === undefined
            ? {}
            : { research_conversation_ceiling_cents: change.conversationCeilingCents }),
          ...(change.dailyCeilingCents === undefined
            ? {}
            : { research_daily_ceiling_cents: change.dailyCeilingCents }),
          ...(change.callLimit === undefined ? {} : { research_call_limit: change.callLimit }),
          ...(change.timeLimitMs === undefined
            ? {}
            : { research_time_limit_ms: change.timeLimitMs }),
          research_updated_at: database.fn.now(),
        })
        .returning<{ research_updated_at: Date | null }[]>(["research_updated_at"]);
      if (!rows[0]) throw new NotAnAdminError();
      return {
        limits: await currentLimits(),
        ceilings: operatorLimits,
        updatedAt: rows[0].research_updated_at ?? undefined,
      };
    },

    async start(userId, conversationId) {
      const conversation = await database("conversations")
        .where({ id: conversationId, user_id: userId })
        .first("id");
      // A conversation the caller does not own is not theirs to research, and
      // saying so any other way would confirm that it exists.
      if (!conversation) throw new ResearchRunNotFoundError();

      return inResearchTransaction(async (transaction) => {
        const limits = await currentLimits(transaction);
        // A run that could never make a call would be a promise the engine
        // cannot keep, so both shared ceilings are checked before it starts.
        const conversationUsed = await conversationUsage(transaction, conversationId);
        if (conversationUsed.usedCents >= limits.conversationCeilingCents) {
          throw new ResearchAllowanceExhaustedError("conversation_ceiling");
        }
        const day = await dailyUsage(transaction, userId);
        if (day.usedCents >= limits.dailyCeilingCents) {
          throw new ResearchAllowanceExhaustedError("daily_ceiling");
        }

        const rows = await transaction("research_runs")
          .insert({
            conversation_id: conversationId,
            user_id: userId,
            state: "running",
            started_at: startedAt,
            resumed_at: now(),
            updated_at: now(),
            run_target_cents: limits.runTargetCents,
            conversation_ceiling_cents: limits.conversationCeilingCents,
            daily_ceiling_cents: limits.dailyCeilingCents,
            call_limit: limits.callLimit,
            time_limit_ms: limits.timeLimitMs,
          })
          .returning<RunRow[]>([...RUN_COLUMNS]);
        const row = rows[0];
        if (!row) throw new Error("Insert returned no row");
        await appendEvent(transaction, row.id, "start", null);
        return toRun(row, transaction);
      });
    },

    async pause(userId, runId) {
      return inResearchTransaction(async (transaction) => {
        const run = await lockedRun(transaction, userId, runId);
        if (run.state !== "running") {
          throw new ResearchRunStateError(`a ${run.state} run cannot be paused`);
        }
        // The results stay on the run: what was already paid for is the
        // shopper's, and pausing stops spending rather than losing work. The
        // working time is banked here so the time spent paused is not charged
        // to the run when it continues.
        const paused = await saveRun(transaction, run.id, {
          state: "paused",
          pauseReason: "shopper",
          elapsedMs: (await usageOf(run, transaction)).durationMs,
          resumedAt: null,
        });
        await appendEvent(transaction, run.id, "pause", "shopper");
        return toRun(paused, transaction);
      });
    },

    async stop(userId, runId) {
      return inResearchTransaction(async (transaction) => {
        const run = await lockedRun(transaction, userId, runId);
        if (run.state === "stopped" || run.state === "completed") {
          throw new ResearchRunStateError(`a ${run.state} run cannot be stopped`);
        }
        const stopped = await saveRun(transaction, run.id, {
          state: "stopped",
          pauseReason: run.pause_reason,
          endedAt: now(),
          // A stopped run is not working, so its clock stops with it.
          elapsedMs: (await usageOf(run, transaction)).durationMs,
          resumedAt: null,
        });
        await appendEvent(transaction, run.id, "stop", run.pause_reason);
        return toRun(stopped, transaction);
      });
    },

    async continue(userId, runId) {
      return inResearchTransaction(async (transaction) => {
        const run = await lockedRun(transaction, userId, runId);
        if (run.state !== "paused") {
          throw new ResearchRunStateError("only a paused run can be continued");
        }
        // Continuation is the same run, so its own spent usage, its
        // conversation's usage, and the shopper's usage today are all left
        // untouched: a pause cannot be used to start again with fresh money.
        // Only the clock restarts, which is the shopper asking for more time
        // rather than for another allowance.
        const resumed = await saveRun(transaction, run.id, {
          state: "running",
          pauseReason: null,
          resumedAt: now(),
        });
        await appendEvent(transaction, run.id, "resume", null);
        return toRun(resumed, transaction);
      });
    },

    async get(userId, runId) {
      return toRun(await requireOwnedRun(userId, runId));
    },

    async list(userId, conversationId) {
      const rows = await database("research_runs")
        .where({ user_id: userId, conversation_id: conversationId })
        .orderBy([
          { column: "started_at", order: "desc" },
          { column: "id", order: "desc" },
        ])
        .select<RunRow[]>([...RUN_COLUMNS]);
      return Promise.all(rows.map((row) => toRun(row)));
    },

    async recordResults(userId, runId, count) {
      if (!Number.isInteger(count) || count < 0) {
        throw new ResearchRunStateError("results are a whole, non-negative count");
      }
      return inResearchTransaction(async (transaction) => {
        const run = await lockedRun(transaction, userId, runId);
        // Kept whatever the run's state is: a stopped run still has the results
        // it paid for, and an adapter finishing a call may still report them.
        const saved = await saveRun(transaction, run.id, {
          resultsRetained: run.results_retained + count,
        });
        return toRun(saved, transaction);
      });
    },

    dailyAllowance,

    async reserve(userId, runId, reservation) {
      // The limit that refuses a reservation is recorded after the refusal's
      // transaction has rolled back, so the reason survives the refusal.
      let reached: ResearchPauseReason | undefined;
      try {
        return await inResearchTransaction(async (transaction) => {
          const run = await lockedRun(transaction, userId, runId);
          if (run.state !== "running") {
            throw new ResearchRunStateError(`a ${run.state} run cannot make a call`);
          }

          const reference = reservation.reference ?? randomUUID();
          // A retried request is the same call, not another one to pay for.
          const existing = await transaction("usage_events")
            .where({ reference, kind: "reserve" })
            .first<ReservationRow>([
              "id",
              "run_id",
              "reference",
              "call_kind",
              "estimated_cents",
              "priced",
            ]);
          if (existing) {
            if (existing.run_id !== run.id) {
              throw new UsageReservationRefusedError("that reference belongs to another run");
            }
            return {
              id: existing.id,
              runId: existing.run_id,
              reference,
              callKind: existing.call_kind,
              reservedCents: cents(existing.estimated_cents),
              priced: existing.priced,
            };
          }

          // Every limit is checked against what the ledger says, not against a
          // counter, so a crashed or abandoned request cannot hide spending.
          const usage = await usageOf(run, transaction);
          if (usage.calls >= run.call_limit) {
            reached = "call_limit";
            throw new ResearchAllowanceExhaustedError("call_limit");
          }
          // Working time, not the clock on the wall: a call in flight already
          // counts for its estimate, and time a run spent paused is not spent.
          const working = usage.durationMs + (reservation.estimatedDurationMs ?? 0);
          if (working > run.time_limit_ms) {
            reached = "time_limit";
            throw new ResearchAllowanceExhaustedError("time_limit");
          }

          const estimated = estimateOf(reservation.pricing);
          if (committed(usage) + estimated > cents(run.run_target_cents)) {
            reached = "run_target";
            throw new ResearchAllowanceExhaustedError("run_target");
          }
          const conversation = await conversationUsage(transaction, run.conversation_id);
          if (conversation.usedCents + estimated > cents(run.conversation_ceiling_cents)) {
            reached = "conversation_ceiling";
            throw new ResearchAllowanceExhaustedError("conversation_ceiling");
          }
          const day = await dailyUsage(transaction, userId);
          if (day.usedCents + estimated > cents(run.daily_ceiling_cents)) {
            reached = "daily_ceiling";
            throw new ResearchAllowanceExhaustedError("daily_ceiling");
          }

          const priced = isPriced(reservation.pricing);
          const rows = await transaction("usage_events")
            .insert({
              run_id: run.id,
              user_id: userId,
              conversation_id: run.conversation_id,
              kind: "reserve",
              reference,
              call_kind: reservation.callKind,
              estimated_cents: estimated,
              // A call whose price is unknown is still counted against the call
              // and time limits; only the money is marked as not known.
              priced,
              calls: 1,
              duration_ms: reservation.estimatedDurationMs ?? 0,
              created_at: now(),
            })
            .returning<{ id: string }[]>(["id"]);
          const inserted = rows[0];
          if (!inserted) throw new Error("Insert returned no row");
          return {
            id: inserted.id,
            runId: run.id,
            reference,
            callKind: reservation.callKind,
            reservedCents: estimated,
            priced,
          };
        });
      } finally {
        if (reached) await pauseForLimit(runId, reached);
      }
    },

    async settle(userId, settlement) {
      return inResearchTransaction(async (transaction) => {
        const reservation = await reservationOf(transaction, userId, settlement.reservationId);
        const run = await lockedRun(transaction, userId, reservation.run_id);
        const actual = settlement.actualCents;
        // A price above the reservation would break the ceiling the estimate was
        // checked against, so the estimate is the most a call may settle at.
        if (actual !== undefined && actual > cents(reservation.estimated_cents)) {
          throw new UsageReservationRefusedError(
            "a call cannot settle for more than its reservation",
          );
        }
        // A call that reserved a known price but settles without one is exactly
        // the case that must not be counted as free: it stays at its estimate
        // and is marked unknown.
        const priced = reservation.priced && actual !== undefined;
        await transaction("usage_events").insert({
          run_id: run.id,
          user_id: userId,
          conversation_id: run.conversation_id,
          kind: "settle",
          reservation_id: reservation.id,
          reference: reservation.reference,
          call_kind: reservation.call_kind,
          estimated_cents: cents(reservation.estimated_cents),
          actual_cents: actual ?? null,
          priced,
          calls: 0,
          duration_ms: settlement.durationMs ?? 0,
          created_at: now(),
        });
        const exhausted = await exhaustedReason(transaction, run);
        const settled = exhausted
          ? await saveRun(transaction, run.id, {
              state: "paused",
              pauseReason: exhausted,
              // The run stops working here, so its clock stops with it.
              elapsedMs: (await usageOf(run, transaction)).durationMs,
              resumedAt: null,
            })
          : run;
        if (exhausted) await appendEvent(transaction, run.id, "pause", exhausted);
        return toRun(settled, transaction);
      });
    },

    async release(userId, reservationId) {
      return inResearchTransaction(async (transaction) => {
        const reservation = await reservationOf(transaction, userId, reservationId);
        const run = await lockedRun(transaction, userId, reservation.run_id);
        // The whole estimate goes back: the call never happened, so it costs
        // nothing and gives back everything it held.
        await transaction("usage_events").insert({
          run_id: run.id,
          user_id: userId,
          conversation_id: run.conversation_id,
          kind: "release",
          reservation_id: reservation.id,
          reference: reservation.reference,
          call_kind: reservation.call_kind,
          estimated_cents: cents(reservation.estimated_cents),
          priced: reservation.priced,
          calls: 0,
          duration_ms: 0,
          created_at: now(),
        });
        const released = await transaction("research_runs")
          .where({ id: run.id })
          .first<RunRow>([...RUN_COLUMNS]);
        if (!released) throw new ResearchRunNotFoundError();
        return toRun(released, transaction);
      });
    },

    async usage(actor) {
      await requireAdmin(actor);
      const calls: Record<UsageCallKind, number> = {
        model: 0,
        retrieval: 0,
        retry: 0,
        fallback: 0,
      };
      // Only what a call cost and what it was for: no conversation content, no
      // titles, no addresses. The figures are the ledger's, not a recount.
      const perCall = await database("usage_events")
        .where({ kind: "reserve" })
        .groupBy("call_kind")
        .select<{ call_kind: UsageCallKind; calls: string }[]>(
          "call_kind",
          database.raw("count(*) AS calls"),
        );
      for (const row of perCall) calls[row.call_kind] = cents(row.calls);

      const totals = await database("usage_events")
        .select(
          database.raw(`coalesce(sum(${SPENT_CENTS}), 0) AS spent_cents`),
          database.raw(`coalesce(sum(${LEDGER_CENTS}), 0) AS held_cents`),
          database.raw(`coalesce(${PRICE_UNKNOWN}, false) AS cost_incomplete`),
        )
        .first<{ spent_cents: string; held_cents: string; cost_incomplete: boolean }>();
      const spentCents = cents(totals?.spent_cents);
      const heldCents = cents(totals?.held_cents);

      const perUser = await database("usage_events")
        .groupBy("user_id")
        .orderBy("user_id")
        .select<
          { user_id: string; calls: string; spent_cents: string; cost_incomplete: boolean }[]
        >(
          "user_id",
          database.raw(`count(*) FILTER (WHERE kind = 'reserve') AS calls`),
          database.raw(`coalesce(sum(${SPENT_CENTS}), 0) AS spent_cents`),
          database.raw(`coalesce(${PRICE_UNKNOWN}, false) AS cost_incomplete`),
        );

      const perConversation = await database("usage_events")
        .groupBy("conversation_id")
        .orderBy("conversation_id")
        .select<{ conversation_id: string; calls: string; spent_cents: string }[]>(
          "conversation_id",
          database.raw(`count(*) FILTER (WHERE kind = 'reserve') AS calls`),
          database.raw(`coalesce(sum(${SPENT_CENTS}), 0) AS spent_cents`),
        );

      const runs: Record<ResearchRunState, number> = {
        running: 0,
        paused: 0,
        stopped: 0,
        completed: 0,
      };
      const perState = await database("research_runs")
        .groupBy("state")
        .select<{ state: ResearchRunState; runs: string }[]>(
          "state",
          database.raw("count(*) AS runs"),
        );
      for (const row of perState) runs[row.state] = cents(row.runs);

      return {
        calls,
        spentCents,
        reservedCents: Math.max(0, heldCents - spentCents),
        costIncomplete: totals?.cost_incomplete === true,
        byUser: perUser.map((row) => ({
          userId: row.user_id,
          calls: cents(row.calls),
          spentCents: cents(row.spent_cents),
          costIncomplete: row.cost_incomplete,
        })),
        byConversation: perConversation.map((row) => ({
          conversationId: row.conversation_id,
          calls: cents(row.calls),
          spentCents: cents(row.spent_cents),
        })),
        runs,
      };
    },
  };
}
