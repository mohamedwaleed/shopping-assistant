// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";

export type BudgetKind = "interactive" | "background";
export interface BudgetSettings { interactiveCents: number; backgroundCents: number; maxInteractive: number; maxBackground: number; retryLimit: number; paidFallbackEnabled: boolean; }
export interface BudgetView extends BudgetSettings { usedInteractiveCents: number; usedBackgroundCents: number; reservedInteractiveCents: number; reservedBackgroundCents: number; backgroundPersonalKeyConsent: boolean; pauseReasons: Partial<Record<BudgetKind, "allowance" | "concurrency" | "personal-key-consent">>; }
export interface BudgetReservation { id: string; kind: BudgetKind; estimatedCents: number; estimate: { exact: false; conservative: true }; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BudgetRegistry {
  read(principal: Principal): Promise<Result<BudgetView>>;
  saveInstallation(principal: Principal, input: BudgetSettings): Promise<Result<BudgetSettings>>;
  saveWorkspace(principal: Principal, input: Pick<BudgetSettings, "interactiveCents" | "backgroundCents" | "paidFallbackEnabled"> & { backgroundPersonalKeyConsent: boolean }): Promise<Result<BudgetView>>;
  reserve(principal: Principal, input: { kind: BudgetKind; estimatedCents: number; usageSource: "installation" | "workspace" }): Promise<Result<BudgetReservation>>;
  retry(principal: Principal, id: string): Promise<Result<void>>;
  settle(principal: Principal, id: string, actualCents: number): Promise<Result<void>>;
  cancel(principal: Principal, id: string): Promise<Result<void>>;
}

function validBudget(value: number, field: string): Result<number> { return Number.isInteger(value) && value >= 0 ? ok(value) : err({ kind: "invalid-input", field, message: "must be a non-negative whole number of cents" }); }
async function admitted(db: Knex, principal: Principal): Promise<Result<string>> {
  if (principal.kind === "anonymous" || !isAuthorized(principal, "workspace.read")) return err({ kind: "forbidden", capability: "workspace.read" });
  if (!UUID.test(principal.workspaceId)) return err({ kind: "invalid-input", field: "workspaceId", message: "workspaceId must be a UUID" });
  const member = await db("workspace_memberships").where({ workspace_id: principal.workspaceId, user_id: principal.userId }).first();
  return member ? ok(principal.workspaceId) : err({ kind: "forbidden", capability: "workspace.read" });
}

export function createBudgetRegistry({ db }: { db: Knex }): BudgetRegistry {
  async function settings(trx: Knex, workspaceId: string) {
    const install = await trx("installation_provider_budget_settings").where({ id: 1 }).first();
    const workspace = await trx("workspace_provider_budget_settings").where({ workspace_id: workspaceId }).first();
    return { install, workspace };
  }
  async function view(principal: Principal): Promise<Result<BudgetView>> {
    const workspaceId = await admitted(db, principal); if (!workspaceId.ok) return workspaceId;
    const { install, workspace } = await settings(db, workspaceId.value);
    const usage = await db("workspace_provider_budget_usage").where({ workspace_id: workspaceId.value });
    const byKind = (kind: BudgetKind, column: "settled_cents" | "reserved_cents") => Number(usage.find((r) => r.kind === kind)?.[column] ?? 0);
    const effective = { interactiveCents: Math.min(Number(workspace?.interactive_cents ?? install.interactive_cents), Number(install.interactive_cents)), backgroundCents: Math.min(Number(workspace?.background_cents ?? install.background_cents), Number(install.background_cents)), maxInteractive: Number(install.max_interactive), maxBackground: Number(install.max_background), retryLimit: Number(install.retry_limit), paidFallbackEnabled: Boolean(install.paid_fallback_enabled) && Boolean(workspace?.paid_fallback_enabled) };
    const pauseReasons: BudgetView["pauseReasons"] = {};
    for (const kind of ["interactive", "background"] as const) if (byKind(kind, "settled_cents") + byKind(kind, "reserved_cents") >= effective[kind === "interactive" ? "interactiveCents" : "backgroundCents"]) pauseReasons[kind] = "allowance";
    return ok({ ...effective, usedInteractiveCents: byKind("interactive", "settled_cents"), usedBackgroundCents: byKind("background", "settled_cents"), reservedInteractiveCents: byKind("interactive", "reserved_cents"), reservedBackgroundCents: byKind("background", "reserved_cents"), backgroundPersonalKeyConsent: Boolean(workspace?.background_personal_key_consent), pauseReasons });
  }
  async function saveInstallation(principal: Principal, input: BudgetSettings): Promise<Result<BudgetSettings>> {
    if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
    for (const [field, value] of Object.entries(input)) if (field !== "paidFallbackEnabled" && (!Number.isInteger(value) || Number(value) < 0 || (field.startsWith("max") && Number(value) < 1))) return err({ kind: "invalid-input", field, message: "must be a valid non-negative limit" });
    await db("installation_provider_budget_settings").where({ id: 1 }).update({ interactive_cents: input.interactiveCents, background_cents: input.backgroundCents, max_interactive: input.maxInteractive, max_background: input.maxBackground, retry_limit: input.retryLimit, paid_fallback_enabled: input.paidFallbackEnabled, updated_at: new Date() });
    return ok(input);
  }
  async function saveWorkspace(principal: Principal, input: Parameters<BudgetRegistry["saveWorkspace"]>[1]): Promise<Result<BudgetView>> {
    const workspaceId = await admitted(db, principal); if (!workspaceId.ok) return workspaceId;
    const a = validBudget(input.interactiveCents, "interactiveCents"); if (!a.ok) return a; const b = validBudget(input.backgroundCents, "backgroundCents"); if (!b.ok) return b;
    const installation = await db("installation_provider_budget_settings").where({ id: 1 }).first();
    await db("workspace_provider_budget_settings").insert({ workspace_id: workspaceId.value, interactive_cents: Math.min(input.interactiveCents, Number(installation.interactive_cents)), background_cents: Math.min(input.backgroundCents, Number(installation.background_cents)), background_personal_key_consent: input.backgroundPersonalKeyConsent, paid_fallback_enabled: Boolean(input.paidFallbackEnabled) && Boolean(installation.paid_fallback_enabled), updated_at: new Date() }).onConflict("workspace_id").merge();
    return view(principal);
  }
  async function reserve(principal: Principal, input: Parameters<BudgetRegistry["reserve"]>[1]): Promise<Result<BudgetReservation>> {
    const workspaceId = await admitted(db, principal); if (!workspaceId.ok) return workspaceId;
    if (input.kind !== "interactive" && input.kind !== "background") return err({ kind: "invalid-input", field: "kind", message: "must be interactive or background" });
    const estimate = validBudget(input.estimatedCents, "estimatedCents"); if (!estimate.ok || estimate.value < 1) return err({ kind: "invalid-input", field: "estimatedCents", message: "must be a positive whole number of cents" });
    return db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`provider-budget:${workspaceId.value}:${input.kind}`]);
      const { install, workspace } = await settings(trx, workspaceId.value);
      if (input.kind === "background" && input.usageSource === "workspace" && !workspace?.background_personal_key_consent) return err({ kind: "background-personal-key-consent-required" });
      const limit = Math.min(Number(workspace?.[input.kind === "interactive" ? "interactive_cents" : "background_cents"] ?? install[input.kind === "interactive" ? "interactive_cents" : "background_cents"]), Number(install[input.kind === "interactive" ? "interactive_cents" : "background_cents"]));
      const usage = await trx("workspace_provider_budget_usage").where({ workspace_id: workspaceId.value, kind: input.kind }).first();
      const settled = Number(usage?.settled_cents ?? 0), reserved = Number(usage?.reserved_cents ?? 0);
      if (settled + reserved + estimate.value > limit) return err({ kind: "budget-paused", reason: "allowance", budgetKind: input.kind });
      const active = await trx("provider_budget_reservations").where({ workspace_id: workspaceId.value, kind: input.kind, state: "reserved" }).count<{ count: string }>("id as count").first();
      if (Number(active?.count ?? 0) >= Number(install[input.kind === "interactive" ? "max_interactive" : "max_background"])) return err({ kind: "budget-paused", reason: "concurrency", budgetKind: input.kind });
      await trx("workspace_provider_budget_usage").insert({ workspace_id: workspaceId.value, kind: input.kind, reserved_cents: reserved + estimate.value, settled_cents: settled }).onConflict(["workspace_id", "kind"]).merge();
      const id = randomUUID(); await trx("provider_budget_reservations").insert({ id, workspace_id: workspaceId.value, kind: input.kind, usage_source: input.usageSource, estimated_cents: estimate.value, state: "reserved", attempts: 0 });
      return ok({ id, kind: input.kind, estimatedCents: estimate.value, estimate: { exact: false, conservative: true } });
    });
  }
  async function finish(principal: Principal, id: string, actualCents: number | null): Promise<Result<void>> {
    const workspaceId = await admitted(db, principal); if (!workspaceId.ok) return workspaceId; if (!UUID.test(id)) return err({ kind: "invalid-input", field: "id", message: "id must be a UUID" });
    if (actualCents !== null) { const v = validBudget(actualCents, "actualCents"); if (!v.ok) return v; }
    return db.transaction(async (trx) => {
      const reservation = await trx("provider_budget_reservations").where({ id, workspace_id: workspaceId.value }).forUpdate().first();
      if (!reservation) return err({ kind: "not-found", resource: "provider-budget-reservation", id });
      if (reservation.state !== "reserved") return ok(undefined);
      const usage = await trx("workspace_provider_budget_usage").where({ workspace_id: workspaceId.value, kind: reservation.kind }).first();
      const reserved = Number(usage.reserved_cents) - Number(reservation.estimated_cents); const settled = Number(usage.settled_cents) + (actualCents ?? 0);
      await trx("workspace_provider_budget_usage").where({ workspace_id: workspaceId.value, kind: reservation.kind }).update({ reserved_cents: reserved, settled_cents: settled });
      await trx("provider_budget_reservations").where({ id }).update({ state: actualCents === null ? "cancelled" : "settled", updated_at: new Date() }); return ok(undefined);
    });
  }
  async function retry(principal: Principal, id: string): Promise<Result<void>> {
    const workspaceId = await admitted(db, principal); if (!workspaceId.ok) return workspaceId;
    if (!UUID.test(id)) return err({ kind: "invalid-input", field: "id", message: "id must be a UUID" });
    return db.transaction(async (trx) => {
      const reservation = await trx("provider_budget_reservations").where({ id, workspace_id: workspaceId.value }).forUpdate().first();
      if (!reservation) return err({ kind: "not-found", resource: "provider-budget-reservation", id });
      const install = await trx("installation_provider_budget_settings").where({ id: 1 }).first();
      if (reservation.state !== "reserved" || Number(reservation.attempts) >= Number(install.retry_limit)) return err({ kind: "budget-retry-exhausted", budgetKind: reservation.kind });
      await trx("provider_budget_reservations").where({ id }).update({ attempts: Number(reservation.attempts) + 1, updated_at: new Date() });
      return ok(undefined);
    });
  }
  return { read: view, saveInstallation, saveWorkspace, reserve, retry, settle: (p, id, cents) => finish(p, id, cents), cancel: (p, id) => finish(p, id, null) };
}
