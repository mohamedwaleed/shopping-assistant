// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { authenticatorCode, createAuthentication, principalForUser } from "../src";
import type { Knex } from "knex";

const url = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

describe("authenticator second factor through the core", () => {
  let db: Knex;
  let auth: ReturnType<typeof createAuthentication>;
  const now = new Date("2026-11-19T10:00:00.000Z");
  const userId = "two-factor-user";
  const workspaceId = "00000000-0000-4000-8000-000000000006";
  const sessionId = "two-factor-session";
  const principal = principalForUser(userId, { workspaceId, role: "owner" }, false, sessionId);

  beforeAll(async () => { db = createDb(url); await db.migrate.latest(); });
  beforeEach(async () => {
    for (const table of ["two_factor_backup_code", "two_factor_authenticator", "workspace_memberships", "workspaces", "session", "account", "user"]) await db(table).delete();
    await db("user").insert({ id: userId, name: "Two Factor", email: "two@example.nl" });
    await db("workspaces").insert({ id: workspaceId, name: "Private", created_by_user_id: userId });
    await db("workspace_memberships").insert({ workspace_id: workspaceId, user_id: userId, role: "owner" });
    await db("session").insert({ id: sessionId, token: "two-factor-token", user_id: userId, expires_at: new Date(now.getTime() + 86_400_000), created_at: now, updated_at: now });
    auth = createAuthentication({ db, now: () => now });
  });
  afterAll(async () => { await db.destroy(); });

  it("requires recent authentication, verifies enrollment, and atomically spends backup codes", async () => {
    expect(await auth.beginTwoFactorEnrollment(principal)).toEqual(expect.objectContaining({ ok: true }));
    const pending = await db("two_factor_authenticator").where({ user_id: userId }).first();
    expect(await auth.confirmTwoFactorEnrollment(principal, { code: "000000" })).toEqual({ ok: false, error: { kind: "invalid-second-factor" } });
    const code = authenticatorCode(pending.secret, now);
    const enabled = await auth.confirmTwoFactorEnrollment(principal, { code });
    expect(enabled.ok).toBe(true); if (!enabled.ok) return;
    expect(enabled.value.recoveryCodes).toHaveLength(10);
    const backup = enabled.value.recoveryCodes[0]!;
    const attempts = await Promise.all([auth.verifySecondFactor(userId, backup), auth.verifySecondFactor(userId, backup)]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(await auth.verifySecondFactor(userId, backup)).toEqual({ ok: false, error: { kind: "invalid-second-factor" } });
  });
});
