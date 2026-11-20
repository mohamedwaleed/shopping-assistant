// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL, migrateFresh } from "@shopping/db";
import { createEmailLinkOperations, principalForUser, type AccountProvisioner, type Authentication, type Mailer } from "../src";

const url = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const adminWorkspaceId = "00000000-0000-4000-8000-000000000001";
const admin = principalForUser("admin", { workspaceId: adminWorkspaceId, role: "owner" }, true, "admin-session");

describe("email-bound account links through the core", () => {
  let db: Knex;
  let messages: string[];
  let links: ReturnType<typeof createEmailLinkOperations>;
  let authentication: Authentication;
  let mailer: Mailer;
  const provisioner: AccountProvisioner = {
    async createCredentialAccount({ name, email }) {
      const id = `user-${email}`;
      await db("user").insert({ id, name, email, email_verified: false });
      await db("account").insert({ id: `account-${email}`, account_id: id, provider_id: "credential", user_id: id, password: "old" });
      return { userId: id };
    }, deleteIdentity: async () => {}, verifyCredentials: async () => null,
  };
  function token(): string {
    const match = messages.at(-1)?.match(/token=([^\s]+)/);
    if (!match) throw new Error("expected a delivered link");
    return decodeURIComponent(match[1]!);
  }
  beforeAll(async () => { db = createDb(url); await migrateFresh(db); });
  beforeEach(async () => {
    await db("workspace_memberships").delete(); await db("workspaces").delete(); await db("session").delete(); await db("account").delete(); await db("user").delete(); await db("verification").delete();
    messages = [];
    mailer = { deliver: async (message: { text: string }) => { messages.push(message.text); return { ok: true as const, value: { delivered: true as const, recipient: "x", messageId: "m", deliveredAt: new Date().toISOString() } }; } } as unknown as Mailer;
    authentication = { recentAuthentication: async () => ({ ok: true as const, value: { recent: true, authenticatedAt: new Date().toISOString(), windowSeconds: 300 } }), admission: async () => ({ ok: true as const, value: { id: "admin", email: "admin@example.nl", name: "Admin", workspace: { workspaceId: adminWorkspaceId, role: "owner" as const } } }), verifySecondFactor: async () => ({ ok: true as const, value: { verified: true as const } }) } as unknown as Authentication;
    links = createEmailLinkOperations({ db, auth: authentication, mail: mailer });
  });
  afterAll(async () => { await db.destroy(); });

  it("accepts a seven-day email-bound invitation once and creates an isolated workspace", async () => {
    expect((await links.invite(admin, { email: "shopper@example.nl", linkBaseUrl: "https://test/invite" }, {} as never)).ok).toBe(true);
    const accepted = await links.acceptInvitation({ email: "shopper@example.nl", token: token(), name: "Shopper", password: "a-long-password", workspaceName: "Private" }, provisioner);
    expect(accepted.ok).toBe(true); if (!accepted.ok) return;
    expect(accepted.value.workspaceId).not.toBe(adminWorkspaceId);
    expect(await links.acceptInvitation({ email: "other@example.nl", token: token(), name: "Other", password: "a-long-password", workspaceName: "Other" }, provisioner)).toEqual({ ok: false, error: { kind: "invalid-email-link" } });
  });

  it("does not enumerate reset requests and atomically spends a reset while revoking sessions", async () => {
    await provisioner.createCredentialAccount({ name: "Shopper", email: "shopper@example.nl", password: "a-long-password" });
    await db("session").insert({ id: "one", token: "one", user_id: "user-shopper@example.nl", expires_at: new Date(Date.now() + 60_000) });
    expect(await links.requestPasswordReset({ email: "nobody@example.nl", linkBaseUrl: "https://test/reset" }, {} as never)).toEqual({ ok: true, value: { delivered: true } });
    expect(await links.requestPasswordReset({ email: "shopper@example.nl", linkBaseUrl: "https://test/reset" }, {} as never)).toEqual({ ok: true, value: { delivered: true } });
    const request = { email: "shopper@example.nl", token: token(), newPassword: "new-long-password" };
    const results = await Promise.all([links.resetPassword(request, { setPassword: async () => {} }), links.resetPassword(request, { setPassword: async () => {} })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await db("session").where({ user_id: "user-shopper@example.nl" })).toHaveLength(0);
  });

  it("refuses expired and replayed links, and surfaces unavailable SMTP delivery", async () => {
    await provisioner.createCredentialAccount({ name: "Shopper", email: "shopper@example.nl", password: "a-long-password" });
    expect(await links.requestPasswordReset({ email: "shopper@example.nl", linkBaseUrl: "https://test/reset" }, {} as never)).toEqual({ ok: true, value: { delivered: true } });
    const expired = token();
    await db("verification").where("identifier", "password-reset:shopper@example.nl").update({ expires_at: new Date(0) });
    expect(await links.resetPassword({ email: "shopper@example.nl", token: expired, newPassword: "new-long-password" }, { setPassword: async () => {} })).toEqual({ ok: false, error: { kind: "invalid-email-link" } });

    const unavailable = createEmailLinkOperations({ db, auth: authentication, mail: { deliver: async () => ({ ok: false as const, error: { kind: "mail-not-configured" as const, missing: "smtp" as const } }) } as unknown as Mailer });
    expect(await unavailable.invite(admin, { email: "new@example.nl", linkBaseUrl: "https://test/invite" }, {} as never)).toEqual({ ok: false, error: { kind: "mail-not-configured", missing: "smtp" } });
    const failed = createEmailLinkOperations({ db, auth: authentication, mail: { deliver: async () => ({ ok: false as const, error: { kind: "mail-delivery-failed" as const, stage: "delivery" as const, reason: "mailbox rejected" } }) } as unknown as Mailer });
    expect(await failed.requestPasswordReset({ email: "shopper@example.nl", linkBaseUrl: "https://test/reset" }, {} as never)).toEqual({ ok: false, error: { kind: "mail-delivery-failed", stage: "delivery", reason: "mailbox rejected" } });
  });

  it("requires recent authentication and only switches identity after new-email confirmation", async () => {
    await db("user").insert({ id: "admin", name: "Admin", email: "admin@example.nl", email_verified: false });
    const stale = createEmailLinkOperations({ db, auth: { ...authentication, recentAuthentication: async () => ({ ok: true as const, value: { recent: false, authenticatedAt: new Date(0).toISOString(), windowSeconds: 300 } }) } as Authentication, mail: mailer });
    expect(await stale.requestEmailChange(admin, { newEmail: "new@example.nl", linkBaseUrl: "https://test/change" }, {} as never)).toEqual({ ok: false, error: { kind: "reauthentication-required" } });
    expect(await links.requestEmailChange(admin, { newEmail: "new@example.nl", linkBaseUrl: "https://test/change" }, {} as never)).toEqual({ ok: true, value: { delivered: true } });
    expect((await db("user").where({ id: "admin" }).first()).email).toBe("admin@example.nl");
    expect(await links.confirmEmailChange({ email: "new@example.nl", token: token() })).toEqual({ ok: true, value: { changed: true } });
    expect((await db("user").where({ id: "admin" }).first()).email).toBe("new@example.nl");
    const unavailable = createEmailLinkOperations({ db, auth: authentication, mail: { deliver: async () => ({ ok: false as const, error: { kind: "mail-not-configured" as const, missing: "smtp" as const } }) } as unknown as Mailer });
    expect(await unavailable.requestEmailChange(admin, { newEmail: "never@example.nl", linkBaseUrl: "https://test/change" }, {} as never)).toEqual({ ok: false, error: { kind: "mail-not-configured", missing: "smtp" } });
    expect((await db("user").where({ id: "admin" }).first()).email).toBe("new@example.nl");
  });
});
