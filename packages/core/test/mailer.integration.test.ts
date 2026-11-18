// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SMTPServer } from "smtp-server";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createAuthentication,
  createMailer,
  nodemailerTransport,
  type AccountProvisioner,
  type Authentication,
  type MailTransport,
  type Principal,
} from "../src/index";

// Core is the seam for protected SMTP settings and the mailer outcome contract:
// real PostgreSQL, a real SMTP conversation against an in-process test inbox,
// and the same authorization path a direct caller uses (no transport between).
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "mailer-integration-setup-token";
const SECRET = "installation-secret-for-encryption-0123456789";
const SMTP_PASSWORD = "smtp-app-password-should-never-leak";

const ADMIN = {
  token: TOKEN,
  name: "Ada Admin",
  email: "ada@example.nl",
  password: "correct-horse-battery",
  workspaceName: "Ada's workspace",
  sessionEstablished: true,
};

/** Stand-in for the identity library; core never hashes or stores passwords. */
function fakeProvisioner(db: Knex): AccountProvisioner {
  return {
    createCredentialAccount: async ({ email, name }) => {
      const id = `identity-${email}`;
      await db("user").insert({ id, name, email, email_verified: false });
      return { userId: id };
    },
    deleteIdentity: async (userId) => {
      await db("user").where({ id: userId }).delete();
    },
    verifyCredentials: async () => null,
  };
}

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

describe("protected SMTP settings and diagnostic delivery", () => {
  let db: Knex;
  let auth: Authentication;
  let admin: Principal;
  let shopper: Principal;
  let inbox: Awaited<ReturnType<typeof startTestInbox>>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    inbox = await startTestInbox();
  });

  beforeEach(async () => {
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
    });
    inbox.messages.length = 0;

    auth = createAuthentication({
      db,
      setupToken: () => ({ kind: "configured", token: TOKEN }),
    });
    const claimed = await auth.claimSetup(ADMIN, fakeProvisioner(db));
    if (!claimed.ok) throw new Error("setup claim failed");

    const shopperId = "identity-shopper@example.nl";
    await db("user").insert({
      id: shopperId,
      name: "Sam Shopper",
      email: "shopper@example.nl",
      email_verified: false,
    });
    const [shopperWorkspace] = await db("workspaces")
      .insert({ name: "Shopper workspace", created_by_user_id: shopperId })
      .returning("id");
    await db("workspace_memberships").insert({
      workspace_id: shopperWorkspace.id,
      user_id: shopperId,
      role: "owner",
    });

    admin = {
      kind: "administrator",
      userId: claimed.value.user.id,
      workspaceId: claimed.value.user.workspace.workspaceId,
      sessionId: "mailer-test-admin-session",
    };
    shopper = {
      kind: "workspace",
      userId: shopperId,
      workspaceId: shopperWorkspace.id,
      sessionId: "mailer-test-shopper-session",
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => inbox.server.close(() => resolve()));
    await db.destroy();
  });

  function mailer(secret = SECRET) {
    return createMailer({ db, installationSecret: secret });
  }

  function transport(): MailTransport {
    return nodemailerTransport();
  }

  function smtpSettings() {
    return {
      host: "127.0.0.1",
      port: inbox.port,
      secure: false,
      username: "smtp-user",
      password: SMTP_PASSWORD,
      fromAddress: "assistant@example.nl",
      fromName: "Shopping Assistant",
    };
  }

  it("reports email as unconfigured before an administrator saves settings", async () => {
    expect(await mailer().settings(admin)).toEqual({
      ok: true,
      value: {
        configured: false,
        smtp: null,
        recipient: null,
        failure: null,
        lastDelivery: null,
      },
    });
  });

  it("stores SMTP settings without ever returning the password", async () => {
    const saved = await mailer().saveSettings(admin, {
      ...smtpSettings(),
      recipient: "diagnostics@example.nl",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.smtp).toEqual({
      host: "127.0.0.1",
      port: inbox.port,
      secure: false,
      username: "smtp-user",
      fromAddress: "assistant@example.nl",
      fromName: "Shopping Assistant",
      passwordSet: true,
    });
    expect(saved.value.recipient).toBe("diagnostics@example.nl");
    expect(JSON.stringify(saved.value)).not.toContain(SMTP_PASSWORD);

    // The password is stored encrypted, not in the clear, and stays masked.
    const stored = await db("installation").where({ id: 1 }).first();
    expect(stored.smtp_settings).toBeTruthy();
    expect(JSON.stringify(stored.smtp_settings)).not.toContain(SMTP_PASSWORD);

    const reread = await mailer().settings(admin);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.smtp?.passwordSet).toBe(true);
    expect(JSON.stringify(reread.value)).not.toContain(SMTP_PASSWORD);
  });

  it("keeps the stored password when an update omits it", async () => {
    await mailer().saveSettings(admin, { ...smtpSettings(), recipient: "first@example.nl" });

    const updated = await mailer().saveSettings(admin, {
      host: "127.0.0.1",
      port: inbox.port,
      secure: false,
      username: "smtp-user",
      fromAddress: "noreply@example.nl",
      fromName: "Shopping Assistant",
      recipient: "second@example.nl",
    });
    expect(updated.ok).toBe(true);

    const sent = await mailer().sendDiagnostic(admin, transport());
    expect(sent.ok).toBe(true);
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0]!.raw).toContain("From: Shopping Assistant <noreply@example.nl>");
    expect(inbox.messages[0]!.to).toEqual(["second@example.nl"]);
  });

  it("delivers a diagnostic message to the explicitly configured recipient", async () => {
    await mailer().saveSettings(admin, {
      ...smtpSettings(),
      recipient: "diagnostics@example.nl",
    });

    const outcome = await mailer().sendDiagnostic(admin, transport());
    expect(outcome).toMatchObject({ ok: true, value: { delivered: true } });
    if (!outcome.ok) return;
    expect(outcome.value.recipient).toBe("diagnostics@example.nl");

    expect(inbox.messages).toHaveLength(1);
    const [message] = inbox.messages;
    expect(message!.from).toBe("assistant@example.nl");
    expect(message!.to).toEqual(["diagnostics@example.nl"]);
    expect(message!.raw).toContain("Subject:");
    expect(message!.raw).not.toContain(SMTP_PASSWORD);
  });

  it("reports a connection failure instead of throwing when the SMTP server is unreachable", async () => {
    await mailer().saveSettings(admin, {
      ...smtpSettings(),
      port: 1,
      recipient: "diagnostics@example.nl",
    });

    const outcome = await mailer().sendDiagnostic(admin, transport());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    if (outcome.error.kind !== "mail-delivery-failed") {
      throw new Error(`expected a delivery failure, got ${outcome.error.kind}`);
    }
    expect(outcome.error.stage).toBe("connection");
    expect(JSON.stringify(outcome.error)).not.toContain(SMTP_PASSWORD);

    const settings = await mailer().settings(admin);
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    expect(settings.value.failure).toMatchObject({ stage: "connection" });
    expect(settings.value.lastDelivery).toMatchObject({ outcome: "failed" });
  });

  it("reports an authentication failure as a delivery failure, not a connection failure", async () => {
    await mailer().saveSettings(admin, {
      ...smtpSettings(),
      password: "wrong-smtp-password",
      recipient: "diagnostics@example.nl",
    });

    const outcome = await mailer().sendDiagnostic(admin, transport());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    if (outcome.error.kind !== "mail-delivery-failed") {
      throw new Error(`expected a delivery failure, got ${outcome.error.kind}`);
    }
    expect(outcome.error.stage).toBe("authentication");
    expect(JSON.stringify(outcome.error)).not.toContain("wrong-smtp-password");
  });

  it("records a successful delivery and clears the previous failure", async () => {
    await mailer().saveSettings(admin, {
      ...smtpSettings(),
      port: 1,
      recipient: "diagnostics@example.nl",
    });
    await mailer().sendDiagnostic(admin, transport());
    await mailer().saveSettings(admin, {
      ...smtpSettings(),
      recipient: "diagnostics@example.nl",
    });
    await mailer().sendDiagnostic(admin, transport());

    const settings = await mailer().settings(admin);
    expect(settings.ok).toBe(true);
    if (!settings.ok) return;
    expect(settings.value.failure).toBeNull();
    expect(settings.value.lastDelivery).toMatchObject({
      outcome: "delivered",
      recipient: "diagnostics@example.nl",
    });
  });

  it("refuses a diagnostic send when the recipient was never configured", async () => {
    await mailer().saveSettings(admin, smtpSettings());

    const outcome = await mailer().sendDiagnostic(admin, transport());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("mail-not-configured");
    expect(inbox.messages).toHaveLength(0);
  });

  it("refuses a diagnostic send when SMTP is unconfigured", async () => {
    const outcome = await mailer().sendDiagnostic(admin, transport());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe("mail-not-configured");
  });

  it("reserves installation email settings for the administrator", async () => {
    expect(await mailer().settings(shopper)).toEqual({
      ok: false,
      error: { kind: "forbidden", capability: "installation.manage" },
    });
    expect(
      await mailer().saveSettings(shopper, {
        ...smtpSettings(),
        recipient: "diagnostics@example.nl",
      }),
    ).toEqual({
      ok: false,
      error: { kind: "forbidden", capability: "installation.manage" },
    });
    expect(await mailer().sendDiagnostic(shopper, transport())).toEqual({
      ok: false,
      error: { kind: "forbidden", capability: "installation.manage" },
    });
  });

  it("rejects invalid settings before anything is stored", async () => {
    const invalid = await mailer().saveSettings(admin, {
      ...smtpSettings(),
      host: "  ",
      recipient: "not-an-address",
    });
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.error.kind).toBe("invalid-input");
    expect((await mailer().settings(admin)).ok && true).toBe(true);
    const stored = await db("installation").where({ id: 1 }).first();
    expect(stored.smtp_settings).toBeNull();
  });

  it("keeps secrets out of logs and out of every reported outcome", async () => {
    const lines: string[] = [];
    const capture = (...parts: unknown[]) => {
      lines.push(parts.map((part) => (part instanceof Error ? part.stack ?? part.message : String(part))).join(" "));
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => {
      const spy = vi.spyOn(console, method).mockImplementation(capture);
      return spy;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });

    const rendered: string[] = [];
    const record = (value: unknown) => rendered.push(JSON.stringify(value));

    try {
      record(await mailer().settings(admin));
      record(
        await mailer().saveSettings(admin, {
          ...smtpSettings(),
          recipient: "diagnostics@example.nl",
        }),
      );
      record(await mailer().settings(admin));
      record(await mailer().sendDiagnostic(admin, transport()));
      record(await mailer().settings(admin));

      // A server that echoes what it received is how a secret could otherwise
      // reach a reported failure reason, and from there a log or a response.
      const echoing = new SMTPServer({
        authOptional: false,
        disabledCommands: ["STARTTLS"],
        onAuth(auth, _session, callback) {
          callback(new Error(`invalid credentials for ${auth.username} ${auth.password}`));
        },
      });
      await new Promise<void>((resolve) => echoing.listen(0, "127.0.0.1", resolve));
      const address = echoing.server.address();
      if (!address || typeof address === "string") throw new Error("echo inbox has no port");
      try {
        await mailer().saveSettings(admin, {
          ...smtpSettings(),
          port: address.port,
          recipient: "diagnostics@example.nl",
        });
        record(await mailer().sendDiagnostic(admin, transport()));
        record(await mailer().settings(admin));
      } finally {
        await new Promise<void>((resolve) => echoing.close(() => resolve()));
      }

      // A wrong installation secret must not surface the ciphertext either.
      const stored = await db("installation")
        .where({ id: 1 })
        .select("smtp_settings")
        .first();
      record(
        await mailer("a-different-installation-secret-0123456789").sendDiagnostic(
          admin,
          transport(),
        ),
      );
      record(stored.smtp_settings);
    } finally {
      for (const spy of spies) spy.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }

    const captured = [...lines, ...rendered].join("\n");
    expect(captured).not.toContain(SMTP_PASSWORD);
    expect(captured).toContain("invalid credentials for smtp-user [redacted]");
    expect(captured).not.toContain(SECRET);
    // The stored row is ciphertext, never the password or the secret itself.
    expect(captured).not.toContain('"passwordCiphertext":"' + SMTP_PASSWORD);
    expect(rendered.some((entry) => entry.includes("mail-delivery-failed"))).toBe(true);
  });
});
