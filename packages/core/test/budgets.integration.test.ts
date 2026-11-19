// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createBudgets,
  createModelRegistry,
  createSecretCipher,
  err,
  ok,
  RESERVATION_TTL_SECONDS,
  type BudgetGrant,
  type Budgets,
  type ModelRegistry,
  type Principal,
  type Result,
} from "../src/index";

// Budgets are enforced at the core boundary: the installation ceiling, the two
// pools, concurrent reservations, settlement, bounded retries, consent and the
// absence of a silent paid fallback are all proven against real PostgreSQL.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const INSTALLATION_SECRET = "installation-secret-0123456789abcdef";

const ADMIN = "budget-admin";
const ADMIN_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SHOPPER = "budget-shopper";
const SHOPPER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OTHER_SHOPPER = "budget-other";
const OTHER_WORKSPACE = "33333333-3333-4333-8333-333333333333";

const administrator: Principal = {
  kind: "administrator",
  userId: ADMIN,
  workspaceId: ADMIN_WORKSPACE,
  sessionId: "budget-admin-session",
};
const shopper: Principal = {
  kind: "workspace",
  userId: SHOPPER,
  workspaceId: SHOPPER_WORKSPACE,
  sessionId: "budget-shopper-session",
};
const other: Principal = {
  kind: "workspace",
  userId: OTHER_SHOPPER,
  workspaceId: OTHER_WORKSPACE,
  sessionId: "budget-other-session",
};

const T0 = new Date("2026-11-19T09:00:00.000Z");

async function seedUsers(db: Knex): Promise<void> {
  await db("user").insert([
    { id: ADMIN, name: "Ada Admin", email: "ada-budget@example.nl" },
    { id: SHOPPER, name: "Sam Shopper", email: "sam-budget@example.nl" },
    { id: OTHER_SHOPPER, name: "Ola Other", email: "ola-budget@example.nl" },
  ]);
  await db("workspaces").insert([
    { id: ADMIN_WORKSPACE, name: "Admin workspace", created_by_user_id: ADMIN },
    { id: SHOPPER_WORKSPACE, name: "Shopper workspace", created_by_user_id: SHOPPER },
    { id: OTHER_WORKSPACE, name: "Other workspace", created_by_user_id: OTHER_SHOPPER },
  ]);
  await db("workspace_memberships").insert([
    { workspace_id: ADMIN_WORKSPACE, user_id: ADMIN, role: "owner" },
    { workspace_id: SHOPPER_WORKSPACE, user_id: SHOPPER, role: "owner" },
    { workspace_id: OTHER_WORKSPACE, user_id: OTHER_SHOPPER, role: "owner" },
  ]);
}

/** The provider call this test pretends to make; records every dispatch. */
function fakeProvider() {
  const calls: string[] = [];
  return {
    calls,
    async call(granted: BudgetGrant): Promise<string> {
      calls.push(granted.reservation.id);
      return `answer-${calls.length}`;
    },
  };
}

const compatibleTarget = {
  provider: "compatible" as const,
  modelId: "fixture-model-complete",
  endpoint: "http://127.0.0.1:9/v1",
};

describe("research and monitoring budgets through the core", () => {
  let db: Knex;
  let registry: ModelRegistry;
  let budgets: Budgets;
  let provider: ReturnType<typeof fakeProvider>;
  let clock: Date;

  function rebuild(): void {
    registry = createModelRegistry({
      db,
      cipher: createSecretCipher({ key: INSTALLATION_SECRET }),
      probe: async () => err({ kind: "provider-unavailable", message: "not used by budgets" }),
      now: () => clock,
    });
    budgets = createBudgets({
      db,
      resolveModel: (principal) => registry.resolve(principal),
      now: () => clock,
    });
  }

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db("budget_reservations").delete();
    await db("budget_periods").delete();
    await db("budget_allowances").delete();
    await db("workspace_budget_permissions").delete();
    await db("workspace_personal_key_consents").delete();
    await db("workspace_model_settings").delete();
    await db("workspace_model_credentials").delete();
    await db("installation_model_settings").delete();
    await db("installation_model_credentials").delete();
    await db("workspace_memberships").delete();
    await db("workspaces").delete();
    await db("user").delete();
    await seedUsers(db);
    clock = T0;
    provider = fakeProvider();
    rebuild();
    await registry.saveInstallation(administrator, {
      defaultModel: compatibleTarget,
      usageSource: "installation",
      extractionOverride: null,
      apiKey: "fixture-installation-key",
    });
  });

  /** The resolved model a caller would pass in; resolution is the registry's job. */
  function resolved() {
    return {
      provider: "compatible" as const,
      modelId: "fixture-model-complete",
      endpoint: "http://127.0.0.1:9/v1",
      role: "default" as const,
      source: "installation" as const,
      usageSource: "installation" as const,
      apiKey: "fixture-installation-key",
    };
  }

  /** Reserve, then either settle what the provider reported or release it. */
  async function runCall(
    principal: Principal,
    pool: "interactive" | "background",
    options: { actual?: { tokens?: number; cents?: number } } = {},
  ): Promise<Result<string>> {
    const granted = await budgets.reserve(principal, { pool, model: resolved() });
    if (!granted.ok) return granted;
    const answer = await provider.call(granted.value);
    const settled = await budgets.settle(principal, {
      reservationId: granted.value.reservation.id,
      ...(options.actual ? { actual: options.actual } : {}),
    });
    if (!settled.ok) return settled;
    return ok(answer);
  }

  function viewOf(view: Awaited<ReturnType<Budgets["read"]>>, pool: "interactive" | "background") {
    if (!view.ok) throw new Error(`budget view refused: ${view.error.kind}`);
    const found = view.value.pools.find((entry) => entry.pool === pool);
    if (!found) throw new Error(`no ${pool} pool in the view`);
    return found;
  }

  describe("installation ceilings", () => {
    it("applies starting allowances to both pools and reports them", async () => {
      const view = await budgets.read(shopper);
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      expect(view.value.pools.map((pool) => pool.pool)).toEqual(["interactive", "background"]);
      expect(viewOf(view, "interactive").effective).toEqual({
        maxCalls: 60,
        maxTokens: 120_000,
        maxCents: 500,
      });
      expect(viewOf(view, "background").effective).toEqual({
        maxCalls: 20,
        maxTokens: 40_000,
        maxCents: 150,
      });
      expect(viewOf(view, "interactive").usage).toEqual({
        calls: 0,
        tokens: 0,
        cents: 0,
        inFlightCalls: 0,
      });
      // Where no exact pre-call price exists the estimate is disclosed.
      expect(view.value.estimates.basis).toBe("conservative");
      expect(view.value.estimates.assumption).toContain("conservative estimate");
    });

    it("clamps a workspace override that asks for more than the ceiling", async () => {
      const saved = await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 5, maxTokens: 100_000, maxCents: 100 },
      });
      expect(saved.ok).toBe(true);
      const permitted = await budgets.saveAllowance(administrator, {
        workspaceId: SHOPPER_WORKSPACE,
        workspaceOverrideAllowed: true,
      });
      expect(permitted.ok).toBe(true);

      const overridden = await budgets.saveAllowance(shopper, {
        workspace: { pool: "interactive", maxCalls: 500, maxTokens: 900_000, maxCents: 9_000 },
      });
      expect(overridden.ok).toBe(true);
      const pool = viewOf(overridden, "interactive");
      // The override is stored clamped to the ceiling, never above it, so a
      // workspace can lower its allowance but cannot raise it.
      expect(pool.workspace).toEqual({ maxCalls: 5, maxTokens: 100_000, maxCents: 100 });
      expect(pool.installation).toEqual({ maxCalls: 5, maxTokens: 100_000, maxCents: 100 });
      expect(pool.effective).toEqual({ maxCalls: 5, maxTokens: 100_000, maxCents: 100 });
      expect(pool.clamped).toBe(false);
      const stored = await db("budget_allowances")
        .where({ scope: "workspace", workspace_id: SHOPPER_WORKSPACE })
        .select("max_calls");
      expect(stored).toEqual([{ max_calls: 5 }]);

      // And the ceiling is what actually pauses: the sixth call is refused.
      for (let index = 0; index < 5; index += 1) {
        expect((await runCall(shopper, "interactive")).ok).toBe(true);
      }
      expect(await budgets.reserve(shopper, { pool: "interactive", model: resolved() })).toEqual({
        ok: false,
        error: {
          kind: "budget-exhausted",
          pool: "interactive",
          reason: "calls-exhausted",
          unit: "calls",
          limit: 5,
          used: 5,
        },
      });
      expect(provider.calls).toHaveLength(5);
    });

    it("refuses a workspace override when the administrator has not allowed one", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 5, maxTokens: 10_000, maxCents: 100 },
      });
      // Without permission the stored row is not applied: the ceiling stands.
      await db("budget_allowances").insert({
        scope: "workspace",
        workspace_id: SHOPPER_WORKSPACE,
        pool: "interactive",
        max_calls: 400,
        max_tokens: 900_000,
        max_cents: 9_000,
      });
      const view = await budgets.read(shopper);
      const pool = viewOf(view, "interactive");
      expect(pool.workspace).toBeNull();
      expect(pool.effective).toEqual({ maxCalls: 5, maxTokens: 10_000, maxCents: 100 });
      expect(pool.clamped).toBe(false);
    });

    it("lets only an administrator set the ceiling or allow overrides", async () => {
      expect(
        await budgets.saveAllowance(shopper, {
          installation: { pool: "interactive", maxCalls: 5, maxTokens: 10_000, maxCents: 100 },
        }),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });
      expect(
        await budgets.saveAllowance(shopper, { workspaceOverrideAllowed: true }),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });
      // Naming another workspace is an installation action, not a shopper one.
      expect(
        await budgets.saveAllowance(shopper, {
          workspaceId: OTHER_WORKSPACE,
          workspace: { pool: "interactive", maxCalls: 1, maxTokens: 10, maxCents: 1 },
        }),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });
      expect(
        await budgets.saveAllowance(administrator, {
          workspaceId: "99999999-9999-4999-8999-999999999999",
          workspaceOverrideAllowed: true,
        }),
      ).toEqual({
        ok: false,
        error: { kind: "not-found", resource: "workspace", id: "99999999-9999-4999-8999-999999999999" },
      });
      expect(await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 5, maxTokens: 10_000, maxCents: 100 },
      })).toMatchObject({ ok: true });
    });

    it("merges each permission separately instead of resetting the other", async () => {
      await budgets.saveAllowance(administrator, {
        workspaceId: SHOPPER_WORKSPACE,
        workspaceOverrideAllowed: true,
      });
      await budgets.saveAllowance(administrator, {
        workspaceId: SHOPPER_WORKSPACE,
        paidFallbackAllowed: true,
      });
      const view = await budgets.read(shopper);
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      // Granting the fallback must not have revoked the override permission.
      expect(view.value.fallback).toEqual({ paidAllowed: false, workspaceMayRequest: true });
      const overridden = await budgets.saveAllowance(shopper, {
        workspace: { pool: "interactive", maxCalls: 7, maxTokens: 5_000, maxCents: 20 },
      });
      expect(viewOf(overridden, "interactive").workspace).toEqual({
        maxCalls: 7,
        maxTokens: 5_000,
        maxCents: 20,
      });
    });

    it("reports an override as clamped when a later ceiling reduction lowers it", async () => {
      await budgets.saveAllowance(administrator, {
        workspaceId: SHOPPER_WORKSPACE,
        workspaceOverrideAllowed: true,
      });
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 10, maxTokens: 50_000, maxCents: 200 },
      });
      await budgets.saveAllowance(shopper, {
        workspace: { pool: "interactive", maxCalls: 8, maxTokens: 40_000, maxCents: 150 },
      });
      // The administrator lowers the ceiling below the stored override: the
      // ceiling now applies and the view says so, so the shopper can see why.
      const lowered = await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 3, maxTokens: 20_000, maxCents: 50 },
      });
      expect(lowered.ok).toBe(true);
      const pool = viewOf(await budgets.read(shopper), "interactive");
      expect(pool.workspace).toEqual({ maxCalls: 8, maxTokens: 40_000, maxCents: 150 });
      expect(pool.effective).toEqual({ maxCalls: 3, maxTokens: 20_000, maxCents: 50 });
      expect(pool.clamped).toBe(true);
    });

    it("rejects an allowance that is not a whole number and clamps one above the hard ceiling", async () => {
      expect(
        await budgets.saveAllowance(administrator, {
          installation: { pool: "interactive", maxCalls: 2.5, maxTokens: 10, maxCents: 10 },
        }),
      ).toEqual({
        ok: false,
        error: {
          kind: "invalid-input",
          field: "installation",
          message:
            "allowance must be whole, non-negative numbers within the installation ceilings",
        },
      });
      expect(
        await budgets.saveAllowance(administrator, {
          installation: { pool: "interactive", maxCalls: -1, maxTokens: 10, maxCents: 10 },
        }),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "installation" } });

      // Above the hard ceiling is clamped rather than accepted: what is stored
      // can never exceed what the installation permits.
      const clamped = await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 5_000, maxTokens: 10_000, maxCents: 100 },
      });
      expect(viewOf(clamped, "interactive").installation).toEqual({
        maxCalls: 1_000,
        maxTokens: 10_000,
        maxCents: 100,
      });
    });
  });

  describe("interactive and background pools", () => {
    it("exhausting one pool does not consume the other", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 2, maxTokens: 10_000, maxCents: 100 },
      });
      await budgets.saveAllowance(administrator, {
        installation: { pool: "background", maxCalls: 3, maxTokens: 10_000, maxCents: 100 },
        workspaceId: SHOPPER_WORKSPACE,
        workspaceOverrideAllowed: true,
      });
      // The shopper sets the overrides themselves once permitted.
      await budgets.saveAllowance(shopper, {
        workspace: { pool: "interactive", maxCalls: 2, maxTokens: 10_000, maxCents: 100 },
      });
      await budgets.saveAllowance(shopper, {
        workspace: { pool: "background", maxCalls: 3, maxTokens: 10_000, maxCents: 100 },
      });

      for (let index = 0; index < 2; index += 1) {
        expect((await runCall(shopper, "interactive")).ok).toBe(true);
      }
      expect(await budgets.reserve(shopper, { pool: "interactive", model: resolved() })).toEqual({
        ok: false,
        error: {
          kind: "budget-exhausted",
          pool: "interactive",
          reason: "calls-exhausted",
          unit: "calls",
          limit: 2,
          used: 2,
        },
      });

      // The background pool is untouched by the interactive exhaustion.
      const background = viewOf(await budgets.read(shopper), "background");
      expect(background.usage.calls).toBe(0);
      expect(background.paused).toBeNull();
      for (let index = 0; index < 3; index += 1) {
        expect((await runCall(shopper, "background")).ok).toBe(true);
      }
      expect(await budgets.reserve(shopper, { pool: "background", model: resolved() })).toMatchObject({
        ok: false,
        error: { kind: "budget-exhausted", pool: "background" },
      });
      // Two interactive and three background calls reached the provider.
      expect(provider.calls).toHaveLength(5);
    });

    it("shares one workspace allowance across every member of the workspace", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 1, maxTokens: 10_000, maxCents: 100 },
      });
      await db("workspace_memberships").insert({
        workspace_id: SHOPPER_WORKSPACE,
        user_id: OTHER_SHOPPER,
        role: "member",
      });
      const colleague: Principal = {
        kind: "workspace",
        userId: OTHER_SHOPPER,
        workspaceId: SHOPPER_WORKSPACE,
        sessionId: "budget-colleague-session",
      };
      expect((await runCall(shopper, "interactive")).ok).toBe(true);
      expect(await budgets.reserve(colleague, { pool: "interactive", model: resolved() })).toMatchObject({
        ok: false,
        error: { kind: "budget-exhausted" },
      });
    });

    it("never admits a principal naming a workspace it does not belong to", async () => {
      const impostor: Principal = {
        kind: "workspace",
        userId: SHOPPER,
        workspaceId: OTHER_WORKSPACE,
        sessionId: "budget-impostor-session",
      };
      expect(await budgets.read(impostor)).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
      expect(await budgets.reserve(impostor, { pool: "interactive", model: resolved() })).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
    });
  });

  describe("concurrent reservations", () => {
    it("hands out exactly the allowed number of calls under simultaneous load", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 4, maxTokens: 1_000_000, maxCents: 10_000 },
      });
      const model = resolved();
      // Eight callers race for four units. Each reservation is its own
      // transaction serialized on the period row, so exactly four succeed and
      // the other four see the spent allowance.
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () => budgets.reserve(shopper, { pool: "interactive", model })),
      );
      const granted = attempts.filter((attempt) => attempt.ok);
      const paused = attempts.filter((attempt) => !attempt.ok);
      expect(granted).toHaveLength(4);
      expect(paused).toHaveLength(4);
      expect(paused.every((attempt) => !attempt.ok && attempt.error.kind === "budget-exhausted")).toBe(true);

      const usage = viewOf(await budgets.read(shopper), "interactive").usage;
      expect(usage.calls).toBe(4);
      expect(usage.inFlightCalls).toBe(4);
      // No overspend: the stored reservations are exactly the allowance.
      const stored = await db("budget_reservations").select("reserved_calls");
      expect(stored).toHaveLength(4);
    });

    it("charges the conservative estimate, not the provider's lower report", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 100, maxTokens: 100_000, maxCents: 100 },
      });
      const granted = await budgets.reserve(shopper, {
        pool: "interactive",
        model: resolved(),
        estimate: { tokens: 3_000, cents: 7 },
      });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(granted.value.reservation.reserved).toEqual({ tokens: 3_000, cents: 7, basis: "estimated" });

      // The provider claims a smaller usage than was reserved: the charge is
      // the higher of the two, so an under-report cannot buy allowance back.
      const settled = await budgets.settle(shopper, {
        reservationId: granted.value.reservation.id,
        actual: { tokens: 100, cents: 1 },
      });
      expect(settled.ok).toBe(true);
      if (!settled.ok) return;
      expect(settled.value.actual).toEqual({ tokens: 3_000, cents: 7, basis: "reported" });
      const usage = viewOf(await budgets.read(shopper), "interactive").usage;
      expect(usage.tokens).toBe(3_000);
      expect(usage.cents).toBe(7);

      // A larger report is charged in full.
      const second = await budgets.reserve(shopper, {
        pool: "interactive",
        model: resolved(),
        estimate: { tokens: 500, cents: 1 },
      });
      if (!second.ok) throw new Error("expected a grant");
      await budgets.settle(shopper, {
        reservationId: second.value.reservation.id,
        actual: { tokens: 4_000, cents: 12 },
      });
      const after = viewOf(await budgets.read(shopper), "interactive").usage;
      expect(after.tokens).toBe(7_000);
      expect(after.cents).toBe(19);
    });

    it("stops a token or spend allowance even when calls remain", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 10, maxTokens: 5_000, maxCents: 10 },
      });
      const first = await budgets.reserve(shopper, {
        pool: "interactive",
        model: resolved(),
        estimate: { tokens: 5_000, cents: 2 },
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      await budgets.settle(shopper, { reservationId: first.value.reservation.id });
      expect(await budgets.reserve(shopper, { pool: "interactive", model: resolved() })).toEqual({
        ok: false,
        error: {
          kind: "budget-exhausted",
          pool: "interactive",
          reason: "tokens-exhausted",
          unit: "tokens",
          limit: 5_000,
          used: 5_000,
        },
      });
      const pool = viewOf(await budgets.read(shopper), "interactive");
      expect(pool.paused).toEqual({
        pool: "interactive",
        reason: "tokens-exhausted",
        unit: "tokens",
        limit: 5_000,
        used: 5_000,
      });
    });

    it("rolls the allowance over when the window ends", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 1, maxTokens: 10_000, maxCents: 100 },
      });
      expect((await runCall(shopper, "interactive")).ok).toBe(true);
      expect(await budgets.reserve(shopper, { pool: "interactive", model: resolved() })).toMatchObject({
        ok: false,
        error: { kind: "budget-exhausted" },
      });
      // Time is injected; nothing sleeps.
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      const rolled = viewOf(await budgets.read(shopper), "interactive");
      expect(rolled.usage.calls).toBe(0);
      expect(rolled.paused).toBeNull();
      expect((await runCall(shopper, "interactive")).ok).toBe(true);
    });
  });

  describe("cancellation and retries", () => {
    it("releases a reservation for a call that never reached the provider", async () => {
      const granted = await budgets.reserve(shopper, { pool: "interactive", model: resolved() });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(viewOf(await budgets.read(shopper), "interactive").usage.calls).toBe(1);

      // Cancelled before dispatch: the call is free and the allowance returns.
      const released = await budgets.release(shopper, granted.value.reservation.id);
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.value.status).toBe("released");
      expect(released.value.reserved).toEqual({ tokens: 0, cents: 0, basis: "estimated" });
      const usage = viewOf(await budgets.read(shopper), "interactive").usage;
      expect(usage).toEqual({ calls: 0, tokens: 0, cents: 0, inFlightCalls: 0 });
      expect(provider.calls).toEqual([]);

      // Releasing or settling it again is refused, never silently applied.
      expect(await budgets.release(shopper, granted.value.reservation.id)).toEqual({
        ok: false,
        error: {
          kind: "budget-reservation-invalid",
          reservationId: granted.value.reservation.id,
          state: "released",
        },
      });
      expect(
        await budgets.settle(shopper, { reservationId: granted.value.reservation.id }),
      ).toMatchObject({ ok: false, error: { kind: "budget-reservation-invalid" } });
    });

    it("charges a call cancelled after dispatch", async () => {
      const granted = await budgets.reserve(shopper, { pool: "interactive", model: resolved() });
      if (!granted.ok) throw new Error("expected a grant");
      await provider.call(granted.value);
      // The provider was contacted, so the unit of work is spent even though
      // the shopper cancelled: it is settled, not released.
      const settled = await budgets.settle(shopper, {
        reservationId: granted.value.reservation.id,
      });
      expect(settled.ok).toBe(true);
      expect(viewOf(await budgets.read(shopper), "interactive").usage.calls).toBe(1);
    });

    it("bounds retries and counts each dispatched attempt", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 10, maxTokens: 1_000_000, maxCents: 10_000 },
      });
      const model = resolved();
      const first = await budgets.reserve(shopper, { pool: "interactive", model });
      if (!first.ok) throw new Error("expected a grant");
      // The provider failed after being contacted, so attempt 1 is settled.
      await budgets.settle(shopper, { reservationId: first.value.reservation.id });

      const second = await budgets.reserve(shopper, {
        pool: "interactive",
        model,
        attempt: 2,
        retryOf: first.value.reservation.id,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.reservation.attempt).toBe(2);
      await budgets.settle(shopper, { reservationId: second.value.reservation.id });

      const third = await budgets.reserve(shopper, {
        pool: "interactive",
        model,
        attempt: 3,
        retryOf: first.value.reservation.id,
      });
      expect(third.ok).toBe(true);
      if (!third.ok) return;
      await budgets.settle(shopper, { reservationId: third.value.reservation.id });

      // A fourth attempt is refused before any provider call: retries are
      // bounded, not unbounded.
      expect(
        await budgets.reserve(shopper, {
          pool: "interactive",
          model,
          attempt: 4,
          retryOf: first.value.reservation.id,
        }),
      ).toEqual({ ok: false, error: { kind: "budget-retry-exhausted", attempts: 3 } });

      // Three dispatches were charged: a retry is never free.
      const usage = viewOf(await budgets.read(shopper), "interactive").usage;
      expect(usage.calls).toBe(3);
      expect(
        await db("budget_reservations").orderBy("attempt").select("attempt", "retry_of"),
      ).toEqual([
        { attempt: 1, retry_of: null },
        { attempt: 2, retry_of: first.value.reservation.id },
        { attempt: 3, retry_of: first.value.reservation.id },
      ]);
    });

    it("releases an abandoned reservation once it expires", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 1, maxTokens: 10_000, maxCents: 100 },
      });
      const granted = await budgets.reserve(shopper, { pool: "interactive", model: resolved() });
      expect(granted.ok).toBe(true);
      expect(await budgets.reserve(shopper, { pool: "interactive", model: resolved() })).toMatchObject({
        ok: false,
        error: { kind: "budget-exhausted" },
      });
      // A crashed worker never settles; the reservation stops holding allowance.
      clock = new Date(T0.getTime() + (RESERVATION_TTL_SECONDS + 1) * 1000);
      expect(viewOf(await budgets.read(shopper), "interactive").usage.calls).toBe(0);
      expect((await budgets.reserve(shopper, { pool: "interactive", model: resolved() })).ok).toBe(true);
    });

    it("refuses a reservation belonging to another workspace", async () => {
      const granted = await budgets.reserve(shopper, { pool: "interactive", model: resolved() });
      if (!granted.ok) throw new Error("expected a grant");
      expect(await budgets.release(other, granted.value.reservation.id)).toEqual({
        ok: false,
        error: {
          kind: "not-found",
          resource: "budget-reservation",
          id: granted.value.reservation.id,
        },
      });
      expect(
        await budgets.settle(other, { reservationId: granted.value.reservation.id }),
      ).toMatchObject({ ok: false, error: { kind: "not-found" } });
    });
  });

  describe("personal-key consent and paid fallback", () => {
    beforeEach(async () => {
      await registry.saveWorkspace(shopper, {
        defaultModel: compatibleTarget,
        usageSource: "workspace",
        extractionOverride: null,
        apiKey: "fixture-workspace-key",
      });
    });

    it("pauses background work on a personal key until the shopper consents", async () => {
      expect(
        await budgets.reserve(shopper, { pool: "background", model: resolved() }),
      ).toEqual({ ok: false, error: { kind: "budget-consent-required", pool: "background" } });
      expect(provider.calls).toEqual([]);
      const beforeConsent = await budgets.read(shopper);
      expect(viewOf(beforeConsent, "background").usage.calls).toBe(0);
      expect(beforeConsent.ok && beforeConsent.value.consent).toEqual({
        backgroundPersonalKey: false,
      });

      // Interactive work on the shopper's own key is the shopper's own action
      // and needs no background consent.
      expect((await runCall(shopper, "interactive")).ok).toBe(true);

      const consented = await budgets.setPersonalKeyBackgroundConsent(shopper, true);
      expect(consented.ok).toBe(true);
      if (!consented.ok) return;
      expect(consented.value.consent).toEqual({ backgroundPersonalKey: true });
      const granted = await budgets.reserve(shopper, { pool: "background", model: resolved() });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(granted.value.reservation.usageSource).toBe("workspace");
    });

    it("does not require consent for background work on the installation account", async () => {
      await registry.saveWorkspace(shopper, {
        defaultModel: compatibleTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: null,
      });
      const granted = await budgets.reserve(shopper, { pool: "background", model: resolved() });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(granted.value.reservation.usageSource).toBe("installation");
    });

    it("reports a paid provider fallback as not enabled and never uses it", async () => {
      const view = await budgets.read(shopper);
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      expect(view.value.fallback).toEqual({ paidAllowed: false, workspaceMayRequest: false });

      // The administrator allows the workspace to ask for it; nothing switches
      // it on for anyone, and the request still resolves to the configured
      // model only.
      const allowed = await budgets.saveAllowance(administrator, {
        workspaceId: SHOPPER_WORKSPACE,
        paidFallbackAllowed: true,
      });
      expect(allowed.ok).toBe(true);
      if (!allowed.ok) return;
      expect(allowed.value.fallback).toEqual({ paidAllowed: false, workspaceMayRequest: true });
      const granted = await budgets.reserve(shopper, { pool: "interactive", model: resolved() });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(granted.value.model.modelId).toBe(compatibleTarget.modelId);
      expect(granted.value.model.provider).toBe("compatible");
      expect(provider.calls).toEqual([]);
    });

    it("never upgrades to a paid provider when the budget allows more work", async () => {
      // A grant carries the model the registry resolved, so a caller cannot
      // reserve against the configured model and call something dearer, and a
      // paused budget returns a typed error instead of another provider.
      const granted = await budgets.reserve(shopper, { pool: "interactive", model: resolved() });
      expect(granted.ok).toBe(true);
      if (!granted.ok) return;
      expect(granted.value.model).toMatchObject({
        provider: "compatible",
        modelId: "fixture-model-complete",
        usageSource: "workspace",
        source: "workspace",
      });
      expect(provider.calls).toEqual([]);
    });
  });

  describe("provider work pauses, never silently falls back", () => {
    it("makes no provider call once the allowance is spent", async () => {
      await budgets.saveAllowance(administrator, {
        installation: { pool: "interactive", maxCalls: 1, maxTokens: 10_000, maxCents: 100 },
      });
      const answered = await runCall(shopper, "interactive");
      expect(answered.ok).toBe(true);
      expect(provider.calls).toHaveLength(1);

      const paused = await runCall(shopper, "interactive");
      expect(paused).toEqual({
        ok: false,
        error: {
          kind: "budget-exhausted",
          pool: "interactive",
          reason: "calls-exhausted",
          unit: "calls",
          limit: 1,
          used: 1,
        },
      });
      // The fixture recorded exactly one request: the paused call never left.
      expect(provider.calls).toHaveLength(1);
      const read = await budgets.read(shopper);
      expect(viewOf(read, "interactive").paused).toEqual({
        pool: "interactive",
        reason: "calls-exhausted",
        unit: "calls",
        limit: 1,
        used: 1,
      });
    });
  });
});
