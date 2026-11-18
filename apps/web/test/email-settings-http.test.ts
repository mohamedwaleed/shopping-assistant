// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SMTPServer } from "smtp-server";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { closeCore, getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";

// Thin HTTP contract checks over real PostgreSQL and a real SMTP conversation:
// status codes, masked settings, delivery failure states, administrator-only
// access and the guarantee that a stored password never reaches a response.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "email-http-contract-setup-token";
const SECRET = "email-http-installation-secret-0123456789";
const SMTP_PASSWORD = "smtp-password-must-not-leak-http";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";

let db: Knex;
let settingsRoute: typeof import("../app/api/administration/email/route");
let diagnosticRoute: typeof import("../app/api/administration/email/diagnostic/route");
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let inbox: { server: SMTPServer; port: number; recipients: string[] };

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookieFrom(response: Response): string {
  const setCookies = response.headers.getSetCookie();
  const session = setCookies.find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!session) throw new Error(`no session cookie in ${JSON.stringify(setCookies)}`);
  return session.split(";")[0]!;
}

function emailSettings(overrides: Record<string, unknown> = {}) {
  return {
    host: "127.0.0.1",
    port: inbox.port,
    secure: false,
    username: "smtp-user",
    password: SMTP_PASSWORD,
    fromAddress: "assistant@example.nl",
    fromName: "Shopping Assistant",
    recipient: "inbox@example.nl",
    ...overrides,
  };
}

async function claimAdministrator(): Promise<string> {
  const claimed = await claimRoute.POST(
    jsonRequest("http://localhost/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
    }),
  );
  expect(claimed.status).toBe(200);
  return sessionCookieFrom(claimed);
}

function saveSettings(cookie: string, body: unknown = emailSettings()) {
  return settingsRoute.PUT(
    new Request("http://localhost/api/administration/email", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
}

function readSettings(cookie: string) {
  return settingsRoute.GET(
    new Request("http://localhost/api/administration/email", { headers: { cookie } }),
  );
}

function sendDiagnostic(cookie: string) {
  return diagnosticRoute.POST(
    new Request("http://localhost/api/administration/email/diagnostic", {
      method: "POST",
      headers: { cookie },
    }),
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "email-http-test-secret-0123456789abcdef";
  process.env.SETUP_TOKEN = TOKEN;
  process.env.INSTALLATION_SECRET = SECRET;

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  const recipients: string[] = [];
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
      recipients.push(...session.envelope.rcptTo.map((recipient) => String(recipient.address)));
      stream.on("data", () => undefined);
      stream.on("end", () => callback());
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("test inbox has no port");
  inbox = { server, port: address.port, recipients };

  settingsRoute = await import("../app/api/administration/email/route");
  diagnosticRoute = await import("../app/api/administration/email/diagnostic/route");
  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
});

beforeEach(async () => {
  inbox.recipients.length = 0;
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => inbox.server.close(() => resolve()));
  closeAuth();
  await closeCore();
  await db.destroy();
});

describe("GET /api/administration/email", () => {
  it("reports unconfigured email for the administrator", async () => {
    const cookie = await claimAdministrator();
    const res = await readSettings(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      configured: false,
      smtp: null,
      recipient: null,
      failure: null,
      lastDelivery: null,
    });
  });

  it("refuses an unauthenticated request with 403", async () => {
    const res = await settingsRoute.GET(new Request("http://localhost/api/administration/email"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("forbidden");
  });

  it("refuses a shopper without installation.manage with 403", async () => {
    await claimAdministrator();
    const shopper = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
      name: "Sam Shopper",
      email: "shopper@example.nl",
      password: "shopper-passphrase-1",
    });
    const [workspace] = await db("workspaces")
      .insert({ name: "Shopper workspace", created_by_user_id: shopper.userId })
      .returning("id");
    await db("workspace_memberships").insert({
      workspace_id: workspace.id,
      user_id: shopper.userId,
      role: "owner",
    });
    const signIn = await signInRoute.POST(
      jsonRequest("http://localhost/api/sign-in", {
        email: "shopper@example.nl",
        password: "shopper-passphrase-1",
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = sessionCookieFrom(signIn);

    expect((await readSettings(cookie)).status).toBe(403);
    expect((await saveSettings(cookie)).status).toBe(403);
    expect((await sendDiagnostic(cookie)).status).toBe(403);
  });
});

describe("PUT /api/administration/email", () => {
  it("stores settings and returns them masked", async () => {
    const cookie = await claimAdministrator();
    const res = await saveSettings(cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SMTP_PASSWORD);
    const body = JSON.parse(text);
    expect(body.configured).toBe(true);
    expect(body.smtp).toEqual({
      host: "127.0.0.1",
      port: inbox.port,
      secure: false,
      username: "smtp-user",
      fromAddress: "assistant@example.nl",
      fromName: "Shopping Assistant",
      passwordSet: true,
    });
    expect(body.recipient).toBe("inbox@example.nl");
    expect(body.smtp.password).toBeUndefined();
    expect(body.smtp.passwordCiphertext).toBeUndefined();
  });

  it("rejects invalid settings with 400 and a field name", async () => {
    const cookie = await claimAdministrator();
    const res = await saveSettings(cookie, emailSettings({ recipient: "not-an-address" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({
      kind: "invalid-input",
      field: "recipient",
    });
  });
});

describe("POST /api/administration/email/diagnostic", () => {
  it("delivers to the configured test inbox and reports success", async () => {
    const cookie = await claimAdministrator();
    await saveSettings(cookie);

    const res = await sendDiagnostic(cookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SMTP_PASSWORD);
    expect(JSON.parse(text)).toMatchObject({
      delivered: true,
      recipient: "inbox@example.nl",
    });
    expect(inbox.recipients).toEqual(["inbox@example.nl"]);
  });

  it("reports an unreachable server as 502 with the connection stage", async () => {
    const cookie = await claimAdministrator();
    await saveSettings(cookie, emailSettings({ port: 1 }));

    const res = await sendDiagnostic(cookie);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.kind).toBe("mail-delivery-failed");
    expect(body.error.stage).toBe("connection");
    expect(JSON.stringify(body)).not.toContain(SMTP_PASSWORD);

    // The failure is visible on the settings screen until a send succeeds.
    const settings = await (await readSettings(cookie)).json();
    expect(settings.failure.stage).toBe("connection");
    expect(settings.lastDelivery.outcome).toBe("failed");
  });

  it("reports wrong SMTP credentials as 502 with the authentication stage", async () => {
    const cookie = await claimAdministrator();
    await saveSettings(cookie, emailSettings({ password: "wrong-smtp-password" }));

    const res = await sendDiagnostic(cookie);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.stage).toBe("authentication");
    expect(JSON.stringify(body)).not.toContain("wrong-smtp-password");
  });

  it("refuses a diagnostic send before settings exist with 409", async () => {
    const cookie = await claimAdministrator();
    const res = await sendDiagnostic(cookie);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ kind: "mail-not-configured", missing: "smtp" });
  });

  it("keeps the stored password out of logs and every response", async () => {
    const captured: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        captured.push(parts.map((part) => String(part)).join(" "));
      }),
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      captured.push(String(chunk));
      return true;
    });
    const responses: string[] = [];
    try {
      const cookie = await claimAdministrator();
      responses.push(await (await saveSettings(cookie)).text());
      responses.push(await (await readSettings(cookie)).text());
      responses.push(await (await sendDiagnostic(cookie)).text());
      responses.push(await (await readSettings(cookie)).text());
      responses.push(await (await saveSettings(cookie, emailSettings({ port: 1 }))).text());
      responses.push(await (await sendDiagnostic(cookie)).text());
      responses.push(await (await readSettings(cookie)).text());
    } finally {
      for (const spy of spies) spy.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
    }

    const everything = [...captured, ...responses].join("\n");
    expect(everything).not.toContain(SMTP_PASSWORD);
    expect(everything).not.toContain(SECRET);
    expect(responses.some((response) => response.includes("mail-delivery-failed"))).toBe(true);
  });
});
