// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, DEFAULT_TEST_DATABASE_URL, migrateFresh } from "@shopping/db";
import { createBudgetRegistry, type Principal } from "../src/index";
import type { Knex } from "knex";

const url = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const workspaceId = "33333333-3333-4333-8333-333333333333";
const principal: Principal = { kind: "workspace", userId: "budget-shopper", workspaceId, sessionId: "budget-session" };
const admin: Principal = { ...principal, kind: "administrator" };

describe("provider budgets through the core", () => {
  let db: Knex;
  let budgets: ReturnType<typeof createBudgetRegistry>;
  beforeAll(async () => { db = createDb(url); await migrateFresh(db); });
  beforeEach(async () => {
    await db("provider_budget_reservations").delete(); await db("workspace_provider_budget_usage").delete();
    await db("workspace_provider_budget_settings").delete(); await db("workspace_memberships").delete(); await db("workspaces").delete(); await db("user").delete();
    await db("user").insert({ id: "budget-shopper", name: "Budget shopper", email: "budget@example.nl" });
    await db("workspaces").insert({ id: workspaceId, name: "Budget workspace", created_by_user_id: "budget-shopper" });
    await db("workspace_memberships").insert({ workspace_id: workspaceId, user_id: "budget-shopper", role: "owner" });
    budgets = createBudgetRegistry({ db });
    const saved = await budgets.saveInstallation(admin, { interactiveCents: 100, backgroundCents: 50, maxInteractive: 1, maxBackground: 1, retryLimit: 1, paidFallbackEnabled: false });
    expect(saved.ok).toBe(true);
  });
  afterAll(async () => { await db.destroy(); });

  it("atomically reserves separate allowances and reports a visible pause", async () => {
    const [first, simultaneous] = await Promise.all([
      budgets.reserve(principal, { kind: "interactive", estimatedCents: 40, usageSource: "installation" }),
      budgets.reserve(principal, { kind: "interactive", estimatedCents: 40, usageSource: "installation" }),
    ]);
    expect([first.ok, simultaneous.ok].filter(Boolean)).toHaveLength(1);
    const refused = first.ok ? simultaneous : first;
    expect(refused).toMatchObject({ ok: false, error: { kind: "budget-paused", reason: "concurrency" } });
    let reservation;
    if (first.ok) reservation = first.value;
    else if (simultaneous.ok) reservation = simultaneous.value;
    else throw new Error("one reservation should succeed");
    expect(await budgets.retry(principal, reservation.id)).toMatchObject({ ok: true });
    expect(await budgets.retry(principal, reservation.id)).toMatchObject({ ok: false, error: { kind: "budget-retry-exhausted" } });
    await budgets.cancel(principal, reservation.id);
    const exhausted = await budgets.reserve(principal, { kind: "interactive", estimatedCents: 120, usageSource: "installation" });
    expect(exhausted).toMatchObject({ ok: false, error: { kind: "budget-paused", reason: "allowance" } });
  });

  it("caps workspace allowances, requires background key consent and never silently enables paid fallback", async () => {
    const override = await budgets.saveWorkspace(principal, { interactiveCents: 999, backgroundCents: 999, backgroundPersonalKeyConsent: false, paidFallbackEnabled: true });
    expect(override).toMatchObject({ ok: true, value: { interactiveCents: 100, backgroundCents: 50, paidFallbackEnabled: false } });
    const denied = await budgets.reserve(principal, { kind: "background", estimatedCents: 1, usageSource: "workspace" });
    expect(denied).toMatchObject({ ok: false, error: { kind: "background-personal-key-consent-required" } });
    await budgets.saveWorkspace(principal, { interactiveCents: 100, backgroundCents: 50, backgroundPersonalKeyConsent: true, paidFallbackEnabled: false });
    const reserved = await budgets.reserve(principal, { kind: "background", estimatedCents: 10, usageSource: "workspace" });
    expect(reserved).toMatchObject({ ok: true, value: { estimate: { exact: false, conservative: true } } });
  });
});
