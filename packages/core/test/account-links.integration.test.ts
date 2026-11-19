// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createAccountLinks,
  createAuthentication,
  createMailer,
  nodemailerTransport,
  RECENT_AUTHENTICATION_SECONDS,
  type AccountLinks,
  type AccountProvisioner,
  type Authentication,
  type CredentialChanger,
  type Mailer,
  type MailTransport,
  type Principal,
} from "../src/index";

// Account access through the core: real PostgreSQL, a real SMTP conversation
// against an in-process test inbox and a clock the test moves by hand. Core is
// the seam for the invitation, reset and email-change lifecycle, so single-use
// atomicity, expiry, account non-enumeration, workspace isolation and the
// recent-authentication gate are all proven here before any HTTP route exists.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const TOKEN = "account-links-one-time-setup-token";
const SECRET = "installation-secret-for-encryption-0123456789";
const SMTP_PASSWORD = "smtp-app-password-should-never-leak";
const BASE_URL = "https://assistant.example.nl";

interface ReceivedMessage {
  from: string;
  to: string[];
  raw: string;
}

/** A local test inbox: a real SMTP server, so delivery is not mocked. */
async function startTestInbox(): Promise<{
  server: SMTPServer;
  port: number;
  messages: ReceivedMessage[];
}> {
  const messages: ReceivedMessage[] = [];
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ["STARTTLS"],
    onAuth(auth, _session, callback) {
      if (auth.username === "smtp-user" && auth.password === SMTP_PASSWORD) {
        callback(null, { user: auth.username });
        return;
      }
      callback(new Error("invalid SMTP credentials"));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        messages.push({
          from: session.envelope.mailFrom ? String(session.envelope.mailFrom.address) : "",
          to: session.envelope.rcptTo.map((recipient) => String(recipient.address)),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("test inbox has no port");
  return { server, port: address.port, messages };
}

describe("invitations, password recovery and email-address changes", () => {
  let db: Knex;
  let auth: Authentication;
  let mail: Mailer;
  let links: AccountLinks;
  let inbox: Awaited<ReturnType<typeof startTestInbox>>;
  let clock: Date;
  /** Passwords the adapter would store, keyed by identity. */
  let storedPasswords: Map<string, string>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    inbox = await startTestInbox();
  });

  beforeEach(async () => {
    await db("account_link_tokens").delete();
    await db("workspace_memberships").delete();
    await db("workspaces").delete();
    await db("session").delete();
    await db("account").delete();
    await db("user").delete();
    await db("installation").update({
      setup_completed_at: null,
      setup_token_hash: null,
      setup_administrator_user_id: null,
      smtp_settings: null,
      mail_delivery: null,
    });
    inbox.messages.length = 0;
    storedPasswords = new Map();
    clock = new Date("2026-11-19T09:00:00.000Z");

    auth = createAuthentication({
      db,
      now: () => clock,
      setupToken: () => ({ kind: "configured", token: TOKEN }),
    });
    mail = createMailer({ db, installationSecret: SECRET, now: () => clock });
    links = createAccountLinks({
      db,
      mail,
      transport: transport(),
      now: () => clock,
      baseUrl: () => BASE_URL,
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => inbox.server.close(() => resolve()));
    await db.destroy();
  });

  function advance(milliseconds: number): void {
    clock = new Date(clock.getTime() + milliseconds);
  }

  function transport(): MailTransport {
    return nodemailerTransport();
  }

  /** Stand-in for the identity library; core never hashes or stores passwords. */
  function provisioner(): AccountProvisioner {
    return {
      createCredentialAccount: async ({ email, name, password }) => {
        const id = `identity-${email}`;
        await db("user").insert({ id, name, email, email_verified: false });
        await db("account").insert({
          id: `account-${id}`,
          account_id: id,
          provider_id: "credential",
          user_id: id,
          password: "hashed-by-the-library",
        });
        storedPasswords.set(id, password);
        return { userId: id };
      },
      deleteIdentity: async (userId) => {
        await db("user").where({ id: userId }).delete();
      },
      verifyCredentials: async ({ email, password }) => {
        const user = await db("user").where({ email }).first();
        if (!user || storedPasswords.get(user.id) !== password) return null;
        return { userId: user.id as string };
      },
    };
  }

  /** The identity library's password write, which core authorizes first. */
  function credentials(): CredentialChanger {
    return {
      changePassword: async ({ userId, currentPassword, newPassword }) => {
        if (storedPasswords.get(userId) !== currentPassword) throw new Error("wrong password");
        storedPasswords.set(userId, newPassword);
      },
      setPassword: async ({ userId, newPassword }) => {
        storedPasswords.set(userId, newPassword);
      },
      changeEmail: async ({ userId, newEmail }) => {
        await db("user").where({ id: userId }).update({ email: newEmail, email_verified: true });
      },
    };
  }

  async function claimAdmin(): Promise<{ userId: string; workspaceId: string }> {
    const claimed = await auth.claimSetup(
      {
        token: TOKEN,
        name: "Ada Admin",
        email: "ada@example.nl",
        password: "correct-horse-battery",
        workspaceName: "Ada's workspace",
        sessionEstablished: true,
      },
      provisioner(),
    );
    if (!claimed.ok) throw new Error(`setup claim failed: ${claimed.error.kind}`);
    storedPasswords.set(claimed.value.user.id, "correct-horse-battery");
    return {
      userId: claimed.value.user.id,
      workspaceId: claimed.value.user.workspace.workspaceId,
    };
  }

  /** Store a session the way the identity library does after a sign-in. */
  async function startSession(userId: string): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    await db("session").insert({
      id: `session-${suffix}`,
      token: `token-${suffix}`,
      user_id: userId,
      expires_at: new Date(clock.getTime() + 7 * DAY_MS),
      created_at: clock,
      updated_at: clock,
      ip_address: "203.0.113.10",
      user_agent: "Mozilla/5.0 (Macintosh) Firefox/128.0",
    });
    return `session-${suffix}`;
  }

  async function principalFor(userId: string, sessionId: string): Promise<Principal> {
    const membership = await db("workspace_memberships").where({ user_id: userId }).first();
    const admin = await auth.administrator(userId);
    return {
      kind: admin.ok ? "administrator" : "workspace",
      userId,
      workspaceId: membership.workspace_id,
      sessionId,
    };
  }

  async function adminPrincipal(): Promise<Principal> {
    const admin = await claimAdmin();
    return principalFor(admin.userId, await startSession(admin.userId));
  }

  /** Configure SMTP against the test inbox; delivery always needs it. */
  async function configureSmtp(principal: Principal, overrides: { port?: number } = {}) {
    const saved = await mail.saveSettings(principal, {
      host: "127.0.0.1",
      port: overrides.port ?? inbox.port,
      secure: false,
      username: "smtp-user",
      password: SMTP_PASSWORD,
      fromAddress: "assistant@example.nl",
      fromName: "Shopping Assistant",
    });
    expect(saved.ok).toBe(true);
  }

  /**
   * Raw token from the delivered message; only its hash is ever stored. The
   * local inbox accepts no 8-bit content, so the body is quoted-printable and
   * the token is recoverable by undoing that encoding: soft `=` breaks go,
   * then the transport's `3D` tag on the first `=`.
   */
  function linkTokenFrom(raw: string, path: string): string {
    const body = raw.replace(/=[ \t]*\r?\n/g, "").replace(/\r\n/g, "\n");
    const marker = `${path}?token=3D`;
    const at = body.indexOf(marker);
    if (at < 0) throw new Error(`no ${path} link in the delivered message`);
    const match = body.slice(at + marker.length).match(/^[A-Za-z0-9_-]+/);
    if (!match) throw new Error(`no ${path} token in the delivered message`);
    return match[0];
  }

  /** Invite from a freshly claimed administrator and read the delivered link. */
  async function invite(email: string, name = "Sam Shopper") {
    const principal = await adminPrincipal();
    await configureSmtp(principal);
    const sent = await links.invite(principal, { email, name });
    expect(sent.ok).toBe(true);
    const raw = inbox.messages.at(-1)!.raw;
    return { principal, token: linkTokenFrom(raw, "/invitations/accept"), raw };
  }

  /** Invite again from the administrator already signed in, returning the token. */
  async function inviteAgain(principal: Principal, email: string, name = "Sam Shopper") {
    const sent = await links.invite(principal, { email, name });
    expect(sent.ok).toBe(true);
    return linkTokenFrom(inbox.messages.at(-1)!.raw, "/invitations/accept");
  }

  async function acceptedShopper(token: string, password = "shopper-passphrase-1") {
    const accepted = await links.acceptInvitation(
      { token, name: "Sam Shopper", password },
      provisioner(),
    );
    if (!accepted.ok) throw new Error(`invitation not accepted: ${accepted.error.kind}`);
    return accepted.value.user;
  }

  describe("invitations", () => {
    it("invites a shopper into their own private workspace without sharing another shopper's data", async () => {
      const invited = await invite("sam@example.nl");
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0]!.to).toEqual(["sam@example.nl"]);
      expect(invited.raw).toContain("https://assistant.example.nl/invitations/accept?token=");
      expect(invited.raw).not.toContain(SMTP_PASSWORD);

      // Only the hash of the token is stored, never the token itself.
      const rows = await db("account_link_tokens").select("*");
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("invitation");
      expect(rows[0].email).toBe("sam@example.nl");
      expect(rows[0].consumed_at).toBeNull();
      expect(JSON.stringify(rows)).not.toContain(invited.token);

      const shopper = await acceptedShopper(invited.token);
      const admin = await db("user").where({ email: "ada@example.nl" }).first();
      expect(shopper.workspace.role).toBe("owner");
      expect(shopper.workspace.workspaceId).not.toBe(
        (await db("workspace_memberships").where({ user_id: admin.id }).first()).workspace_id,
      );

      // Each shopper is a member of exactly one workspace, their own.
      expect(await db("workspace_memberships").where({ user_id: shopper.id })).toHaveLength(1);
      const shopperSessions = await db("session").where({ user_id: shopper.id });
      expect(shopperSessions).toHaveLength(0);
    });

    it("keeps the invitation single-use and bound to the invited address", async () => {
      const invited = await invite("sam@example.nl");
      await acceptedShopper(invited.token);

      // A replay after acceptance creates nothing.
      expect(
        await links.acceptInvitation(
          { token: invited.token, name: "Sam Again", password: "another-passphrase-1" },
          provisioner(),
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-account-link" } });
      expect(await db("user").where({ email: "sam@example.nl" })).toHaveLength(1);
    });

    it("expires an invitation seven days after it was sent", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      const first = await inviteAgain(principal, "sam@example.nl");
      const late = await inviteAgain(principal, "kim@example.nl", "Kim Shopper");

      // Just inside the window the first invitation still works.
      advance(7 * DAY_MS - MINUTE_MS);
      expect(
        (
          await links.acceptInvitation(
            { token: first, name: "Sam Shopper", password: "shopper-passphrase-1" },
            provisioner(),
          )
        ).ok,
      ).toBe(true);

      advance(MINUTE_MS);
      expect(
        await links.acceptInvitation(
          { token: late, name: "Kim Shopper", password: "shopper-passphrase-1" },
          provisioner(),
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-account-link" } });
      expect(await db("user").where({ email: "kim@example.nl" })).toHaveLength(0);
    });

    it("refuses the invitation when SMTP is not configured and creates nothing", async () => {
      const principal = await adminPrincipal();
      expect(await links.invite(principal, { email: "sam@example.nl", name: "Sam Shopper" })).toEqual(
        { ok: false, error: { kind: "mail-not-configured", missing: "smtp" } },
      );
      expect(await db("account_link_tokens")).toHaveLength(0);
      expect(inbox.messages).toHaveLength(0);
    });

    it("reports a delivery failure and leaves no usable invitation", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal, { port: 1 });
      const failed = await links.invite(principal, { email: "sam@example.nl", name: "Sam Shopper" });
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.error.kind).toBe("mail-delivery-failed");
      expect(await db("account_link_tokens").where({ kind: "invitation", consumed_at: null })).toHaveLength(0);
      expect(inbox.messages).toHaveLength(0);
    });

    it("revokes the previous invitation when the same address is invited again", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      const first = await inviteAgain(principal, "sam@example.nl");
      const second = await inviteAgain(principal, "sam@example.nl");
      expect(second).not.toBe(first);

      expect(
        await links.acceptInvitation(
          { token: first, name: "Sam Shopper", password: "shopper-passphrase-1" },
          provisioner(),
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-account-link" } });
      await acceptedShopper(second);
    });

    it("refuses an invitation for an address that already has an account", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      expect(
        await links.invite(principal, { email: "ada@example.nl", name: "Ada Again" }),
      ).toEqual({
        ok: false,
        error: { kind: "invalid-input", field: "email", message: "email is already in use" },
      });
      expect(inbox.messages).toHaveLength(0);
    });

    it("is reserved for the installation administrator", async () => {
      const invited = await invite("sam@example.nl");
      const shopper = await acceptedShopper(invited.token);
      const shopperPrincipal = await principalFor(shopper.id, await startSession(shopper.id));
      expect(
        await links.invite(shopperPrincipal, { email: "kim@example.nl", name: "Kim Shopper" }),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });
    });

    it("rejects a weak password or a mismatched name before creating an account", async () => {
      const invited = await invite("sam@example.nl");
      expect(
        await links.acceptInvitation(
          { token: invited.token, name: "Sam Shopper", password: "short" },
          provisioner(),
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "password" } });
      expect(
        await links.acceptInvitation(
          { token: invited.token, name: "", password: "shopper-passphrase-1" },
          provisioner(),
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "name" } });
      expect(await db("user").where({ email: "sam@example.nl" })).toHaveLength(0);
    });
  });

  describe("password recovery", () => {
    it("answers identically for a known and an unknown address", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);

      const known = await links.requestPasswordReset({ email: "ada@example.nl" });
      const unknown = await links.requestPasswordReset({ email: "nobody@example.nl" });
      expect(known).toEqual({ ok: true, value: { accepted: true } });
      expect(unknown).toEqual(known);
      // Only the known address receives a message, and only its hash is stored.
      expect(inbox.messages).toHaveLength(1);
      expect(inbox.messages[0]!.to).toEqual(["ada@example.nl"]);
      expect(await db("account_link_tokens").where({ kind: "password-reset" })).toHaveLength(1);
    });

    it("still answers identically when email delivery is unavailable", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal, { port: 1 });

      const failed = await links.requestPasswordReset({ email: "ada@example.nl" });
      expect(failed).toEqual({ ok: true, value: { accepted: true } });
      // A failed delivery leaves no reset token behind to be guessed or replayed.
      expect(await db("account_link_tokens").where({ kind: "password-reset" })).toHaveLength(0);
    });

    it("answers identically when SMTP is not configured at all", async () => {
      await adminPrincipal();
      expect(await links.requestPasswordReset({ email: "ada@example.nl" })).toEqual({
        ok: true,
        value: { accepted: true },
      });
      expect(await db("account_link_tokens")).toHaveLength(0);
    });

    it("expires a reset link after thirty minutes", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      await links.requestPasswordReset({ email: "ada@example.nl" });
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/reset-password");

      advance(30 * MINUTE_MS);
      expect(
        await links.resetPassword(
          { token, newPassword: "next-passphrase-1" },
          credentials(),
        ),
      ).toEqual({ ok: false, error: { kind: "invalid-account-link" } });
      expect(storedPasswords.get((await db("user").where({ email: "ada@example.nl" }).first()).id))
        .toBe("correct-horse-battery");
    });

    it("accepts a reset before thirty minutes and revokes every existing session", async () => {
      const admin = await claimAdmin();
      const first = await startSession(admin.userId);
      const second = await startSession(admin.userId);
      const principal = await principalFor(admin.userId, first);
      await configureSmtp(principal);

      await links.requestPasswordReset({ email: "ada@example.nl" });
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/reset-password");
      advance(29 * MINUTE_MS);

      expect(
        await links.resetPassword({ token, newPassword: "next-passphrase-1" }, credentials()),
      ).toEqual({ ok: true, value: { reset: true, sessionsRevoked: 2 } });
      expect(storedPasswords.get(admin.userId)).toBe("next-passphrase-1");
      expect(await db("session").where({ user_id: admin.userId })).toHaveLength(0);
      expect(await auth.requireSession(admin.userId, second)).toEqual({
        ok: false,
        error: { kind: "invalid-credentials" },
      });
    });

    it("consumes the reset link exactly once under two concurrent consumers", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      await links.requestPasswordReset({ email: "ada@example.nl" });
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/reset-password");

      const outcomes = await Promise.all([
        links.resetPassword({ token, newPassword: "first-passphrase-1" }, credentials()),
        links.resetPassword({ token, newPassword: "second-passphrase-1" }, credentials()),
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => !outcome.ok && outcome.error.kind === "invalid-account-link"),
      ).toHaveLength(1);
    });

    it("does not let a spent link reset the password again", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      await links.requestPasswordReset({ email: "ada@example.nl" });
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/reset-password");

      expect((await links.resetPassword({ token, newPassword: "next-passphrase-1" }, credentials())).ok)
        .toBe(true);
      expect(
        await links.resetPassword({ token, newPassword: "third-passphrase-1" }, credentials()),
      ).toEqual({ ok: false, error: { kind: "invalid-account-link" } });
      const admin = await db("user").where({ email: "ada@example.nl" }).first();
      expect(storedPasswords.get(admin.id)).toBe("next-passphrase-1");
    });

    it("rejects a weak or missing new password without spending the link", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      await links.requestPasswordReset({ email: "ada@example.nl" });
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/reset-password");

      expect(
        await links.resetPassword({ token, newPassword: "short" }, credentials()),
      ).toMatchObject({ ok: false, error: { kind: "invalid-input", field: "newPassword" } });
      expect(
        (await links.resetPassword({ token, newPassword: "next-passphrase-1" }, credentials())).ok,
      ).toBe(true);
    });

    it("revokes sessions even when the password write fails, and spends the link", async () => {
      const admin = await claimAdmin();
      await startSession(admin.userId);
      const principal = await principalFor(admin.userId, await startSession(admin.userId));
      await configureSmtp(principal);
      await links.requestPasswordReset({ email: "ada@example.nl" });
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/reset-password");

      const failing: CredentialChanger = {
        changePassword: async () => {
          throw new Error("must not run");
        },
        setPassword: async () => {
          throw new Error("the identity library could not write the password");
        },
        changeEmail: async () => {
          throw new Error("must not run");
        },
      };
      expect(await links.resetPassword({ token, newPassword: "next-passphrase-1" }, failing))
        .toEqual({ ok: false, error: { kind: "invalid-credentials" } });
      expect(await db("session").where({ user_id: admin.userId })).toHaveLength(0);
      expect(
        await links.resetPassword({ token, newPassword: "next-passphrase-1" }, credentials()),
      ).toEqual({ ok: false, error: { kind: "invalid-account-link" } });
    });
  });

  describe("email-address changes", () => {
    it("requires recent authentication before confirming the new address", async () => {
      const admin = await claimAdmin();
      const sessionId = await startSession(admin.userId);
      const principal = await principalFor(admin.userId, sessionId);
      await configureSmtp(principal);

      advance(RECENT_AUTHENTICATION_SECONDS * 1000 + 3000);
      expect(
        await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links),
      ).toEqual({ ok: false, error: { kind: "reauthentication-required" } });
      expect(inbox.messages).toHaveLength(0);
      expect(await db("user").where({ email: "ada@example.com" })).toHaveLength(0);
    });

    it("keeps the old address until the new one is confirmed", async () => {
      const admin = await claimAdmin();
      const principal = await principalFor(admin.userId, await startSession(admin.userId));
      await configureSmtp(principal);

      const requested = await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links);
      expect(requested).toEqual({ ok: true, value: { confirmationSent: true } });
      // The identity is unchanged, and the confirmation went to the new address.
      expect(await db("user").where({ email: "ada@example.nl" })).toHaveLength(1);
      expect(inbox.messages.at(-1)!.to).toEqual(["ada@example.com"]);
      expect(await db("account_link_tokens").where({ kind: "email-change" })).toHaveLength(1);

      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/email-change/confirm");
      expect(await links.confirmEmailChange({ token }, credentials())).toEqual({
        ok: true,
        value: { confirmed: true, email: "ada@example.com" },
      });
      const user = await db("user").where({ id: admin.userId }).first();
      expect(user.email).toBe("ada@example.com");
      expect(user.email_verified).toBe(true);
      // The workspace stays the same: the account identity moved, not the data.
      expect(await db("workspace_memberships").where({ user_id: admin.userId })).toHaveLength(1);
    });

    it("expires an email-change confirmation after thirty minutes", async () => {
      const admin = await claimAdmin();
      const principal = await principalFor(admin.userId, await startSession(admin.userId));
      await configureSmtp(principal);
      await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links);
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/email-change/confirm");

      advance(30 * MINUTE_MS);
      expect(await links.confirmEmailChange({ token }, credentials())).toEqual({
        ok: false,
        error: { kind: "invalid-account-link" },
      });
      expect((await db("user").where({ id: admin.userId }).first()).email).toBe("ada@example.nl");
    });

    it("consumes the confirmation exactly once under two concurrent consumers", async () => {
      const admin = await claimAdmin();
      const principal = await principalFor(admin.userId, await startSession(admin.userId));
      await configureSmtp(principal);
      await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links);
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/email-change/confirm");

      const outcomes = await Promise.all([
        links.confirmEmailChange({ token }, credentials()),
        links.confirmEmailChange({ token }, credentials()),
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    });

    it("revokes every session after the address changes", async () => {
      const admin = await claimAdmin();
      const current = await startSession(admin.userId);
      const other = await startSession(admin.userId);
      const principal = await principalFor(admin.userId, current);
      await configureSmtp(principal);
      await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links);
      const token = linkTokenFrom(inbox.messages.at(-1)!.raw, "/email-change/confirm");

      expect(await links.confirmEmailChange({ token }, credentials())).toEqual({
        ok: true,
        value: { confirmed: true, email: "ada@example.com" },
      });
      expect(await db("session").where({ user_id: admin.userId })).toHaveLength(0);
      expect(await auth.requireSession(admin.userId, other)).toMatchObject({ ok: false });
    });

    it("does not report a completed change when email is unavailable", async () => {
      const admin = await claimAdmin();
      const principal = await principalFor(admin.userId, await startSession(admin.userId));

      expect(
        await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links),
      ).toEqual({ ok: false, error: { kind: "mail-not-configured", missing: "smtp" } });

      await configureSmtp(principal, { port: 1 });
      const failed = await auth.changeEmail(principal, { newEmail: "ada@example.com" }, links);
      expect(failed.ok).toBe(false);
      if (failed.ok) return;
      expect(failed.error.kind).toBe("mail-delivery-failed");
      expect((await db("user").where({ id: admin.userId }).first()).email).toBe("ada@example.nl");
      expect(await db("account_link_tokens").where({ kind: "email-change" })).toHaveLength(0);
    });

    it("refuses an address that another account already uses, without revealing it", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      await acceptedShopper(await inviteAgain(principal, "sam@example.nl"));

      expect(
        await auth.changeEmail(principal, { newEmail: "sam@example.nl" }, links),
      ).toEqual({
        ok: false,
        error: { kind: "invalid-input", field: "newEmail", message: "email is already in use" },
      });
      expect(inbox.messages.filter((message) => message.to.includes("sam@example.nl"))).toHaveLength(1);
    });

    it("refuses the address the account already uses", async () => {
      const principal = await adminPrincipal();
      await configureSmtp(principal);
      expect(
        await auth.changeEmail(principal, { newEmail: "ADA@example.nl" }, links),
      ).toEqual({
        ok: false,
        error: { kind: "invalid-input", field: "newEmail", message: "email is unchanged" },
      });
    });
  });
});
