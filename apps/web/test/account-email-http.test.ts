// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";

// Thin HTTP contract checks for the account-email lifecycle over the real
// identity library, PostgreSQL and an in-process SMTP inbox: invitations,
// password recovery that never enumerates accounts, email-address changes that
// wait for the new mailbox, and the refusal of a public administrator override.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "account-email-one-time-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";
const SHOPPER_PASSWORD = "shopper-passphrase-1";
const SMTP_PASSWORD = "smtp-app-password-should-never-leak";

const ORIGIN = "http://localhost:3000";

interface ReceivedMessage {
  to: string[];
  raw: string;
}

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

let db: Knex;
let inbox: Awaited<ReturnType<typeof startTestInbox>>;
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let accountRoute: typeof import("../app/api/account/route");
let emailRoute: typeof import("../app/api/account/email/route");
let emailConfirmRoute: typeof import("../app/api/account/email/confirm/route");
let invitationsRoute: typeof import("../app/api/invitations/route");
let invitationAcceptRoute: typeof import("../app/api/invitations/accept/route");
let passwordResetRoute: typeof import("../app/api/password-reset/route");
let passwordResetConfirmRoute: typeof import("../app/api/password-reset/confirm/route");
let adminRecoveryRoute: typeof import("../app/api/administration/recovery/route");
let emailSettingsRoute: typeof import("../app/api/administration/email/route");

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      host: "localhost:3000",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function sessionCookieFrom(response: Response): string {
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!session) throw new Error(`no session cookie in ${JSON.stringify(response.headers.getSetCookie())}`);
  return session.split(";")[0]!;
}

function tokenFrom(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
}

async function sessionIdFor(cookie: string): Promise<string> {
  const row = await db("session").where({ token: tokenFrom(cookie) }).first();
  if (!row) throw new Error("no stored session for this cookie");
  return row.id as string;
}

/**
 * Raw link token from the delivered message. The inbox accepts no 8-bit
 * content, so the body is quoted-printable: undo the soft `=` line breaks and
 * the transport's `3D` tag on the first `=`, then read the token.
 */
function linkTokenFrom(path: string): string {
  const raw = inbox.messages.at(-1)?.raw;
  if (!raw) throw new Error("no message was delivered");
  const body = raw.replace(/=[ \t]*\r?\n/g, "").replace(/\r\n/g, "\n");
  const at = body.indexOf(`${path}?token=3D`);
  if (at < 0) throw new Error(`no ${path} link in the delivered message`);
  const match = body.slice(at + `${path}?token=3D`.length).match(/^[A-Za-z0-9_-]+/);
  if (!match) throw new Error(`no ${path} token in the delivered message`);
  return match[0];
}

async function claim(): Promise<void> {
  const res = await claimRoute.POST(
    jsonRequest(`${ORIGIN}/api/setup/claim`, {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
    }),
  );
  expect(res.status).toBe(200);
}

async function signIn(email: string, password: string): Promise<Response> {
  return signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email, password }));
}

async function adminCookie(): Promise<string> {
  const res = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

/** SMTP settings the administrator saves through the protected route. */
async function configureSmtp(cookie: string, port = inbox.port): Promise<void> {
  const res = await emailSettingsRoute.PUT(
    new Request(`${ORIGIN}/api/administration/email`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        host: "localhost:3000",
        cookie,
      },
      body: JSON.stringify({
        host: "127.0.0.1",
        port,
        secure: false,
        username: "smtp-user",
        password: SMTP_PASSWORD,
        fromAddress: "assistant@example.nl",
        fromName: "Shopping Assistant",
        recipient: "diagnostics@example.nl",
      }),
    }),
  );
  expect(res.status).toBe(200);
}

async function inviteShopper(cookie: string, email = "shopper@example.nl"): Promise<string> {
  const res = await invitationsRoute.POST(
    jsonRequest(`${ORIGIN}/api/invitations`, { email, name: "Sam Shopper" }, { cookie }),
  );
  expect(res.status).toBe(200);
  return linkTokenFrom("/invitations/accept");
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.BETTER_AUTH_SECRET = "account-email-test-secret-0123456789abcd";
  process.env.SETUP_TOKEN = TOKEN;
  process.env.INSTALLATION_SECRET = "installation-secret-for-encryption-0123456789";

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();
  // Touch the shared pool now, so it is opened against the test database.
  await getDb().raw("select 1");
  inbox = await startTestInbox();

  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  accountRoute = await import("../app/api/account/route");
  emailRoute = await import("../app/api/account/email/route");
  emailConfirmRoute = await import("../app/api/account/email/confirm/route");
  invitationsRoute = await import("../app/api/invitations/route");
  invitationAcceptRoute = await import("../app/api/invitations/accept/route");
  passwordResetRoute = await import("../app/api/password-reset/route");
  passwordResetConfirmRoute = await import("../app/api/password-reset/confirm/route");
  adminRecoveryRoute = await import("../app/api/administration/recovery/route");
  emailSettingsRoute = await import("../app/api/administration/email/route");
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
});

afterAll(async () => {
  await new Promise<void>((resolve) => inbox.server.close(() => resolve()));
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

describe("POST /api/invitations", () => {
  it("invites a shopper and admits them into their own private workspace", async () => {
    await claim();
    const cookie = await adminCookie();
    await configureSmtp(cookie);
    const token = await inviteShopper(cookie);
    expect(inbox.messages.at(-1)!.to).toEqual(["shopper@example.nl"]);

    const accepted = await invitationAcceptRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations/accept`, {
        token,
        name: "Sam Shopper",
        password: SHOPPER_PASSWORD,
      }),
    );
    expect(accepted.status).toBe(200);
    const body = await accepted.json();
    expect(body.user.email).toBe("shopper@example.nl");

    const shopperCookie = sessionCookieFrom(await signIn("shopper@example.nl", SHOPPER_PASSWORD));
    const shopperAccount = await (
      await accountRoute.GET(new Request(`${ORIGIN}/api/account`, { headers: { cookie: shopperCookie } }))
    ).json();
    const adminAccount = await (
      await accountRoute.GET(new Request(`${ORIGIN}/api/account`, { headers: { cookie } }))
    ).json();
    expect(shopperAccount.workspace.id).not.toBe(adminAccount.workspace.id);
    expect(shopperAccount.user.email).toBe("shopper@example.nl");

    // A replay of the same invitation admits nobody a second time.
    const replay = await invitationAcceptRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations/accept`, {
        token,
        name: "Sam Again",
        password: "another-passphrase-1",
      }),
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.kind).toBe("invalid-account-link");
  });

  it("refuses an invitation before SMTP is configured and keeps accounts private", async () => {
    await claim();
    const cookie = await adminCookie();
    const res = await invitationsRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations`, { email: "shopper@example.nl", name: "Sam" }, { cookie }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ kind: "mail-not-configured", missing: "smtp" });
    expect(inbox.messages).toHaveLength(0);
  });

  it("is reserved for the installation administrator", async () => {
    await claim();
    const cookie = await adminCookie();
    await configureSmtp(cookie);
    const token = await inviteShopper(cookie);
    await invitationAcceptRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations/accept`, {
        token,
        name: "Sam Shopper",
        password: SHOPPER_PASSWORD,
      }),
    );
    const shopperCookie = sessionCookieFrom(await signIn("shopper@example.nl", SHOPPER_PASSWORD));

    const res = await invitationsRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations`, { email: "kim@example.nl", name: "Kim" }, { cookie: shopperCookie }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("forbidden");
  });

  it("rejects a cross-origin invitation", async () => {
    await claim();
    const cookie = await adminCookie();
    await configureSmtp(cookie);
    const res = await invitationsRoute.POST(
      jsonRequest(
        `${ORIGIN}/api/invitations`,
        { email: "shopper@example.nl", name: "Sam" },
        { cookie, origin: "https://attacker.example" },
      ),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("invalid-origin");
  });
});

describe("POST /api/password-reset", () => {
  it("answers identically for known and unknown addresses", async () => {
    await claim();
    const cookie = await adminCookie();
    await configureSmtp(cookie);

    const known = await passwordResetRoute.POST(
      jsonRequest(`${ORIGIN}/api/password-reset`, { email: ADMIN_EMAIL }),
    );
    const unknown = await passwordResetRoute.POST(
      jsonRequest(`${ORIGIN}/api/password-reset`, { email: "nobody@example.nl" }),
    );
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(known.status);
    expect(await known.json()).toEqual({ accepted: true });
    expect(await unknown.json()).toEqual({ accepted: true });
    expect(inbox.messages).toHaveLength(1);
  });

  it("answers identically when email delivery is unavailable", async () => {
    await claim();
    const cookie = await adminCookie();
    await configureSmtp(cookie, 1);

    const res = await passwordResetRoute.POST(
      jsonRequest(`${ORIGIN}/api/password-reset`, { email: ADMIN_EMAIL }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
  });

  it("resets the password, signs out every device and refuses a replay", async () => {
    await claim();
    const first = await adminCookie();
    const second = await adminCookie();
    await configureSmtp(first);
    await passwordResetRoute.POST(jsonRequest(`${ORIGIN}/api/password-reset`, { email: ADMIN_EMAIL }));
    const token = linkTokenFrom("/reset-password");

    const reset = await passwordResetConfirmRoute.POST(
      jsonRequest(`${ORIGIN}/api/password-reset/confirm`, {
        token,
        newPassword: "operator-passphrase-2",
      }),
    );
    expect(reset.status).toBe(200);
    // Sign-in checks the password twice, and each check leaves a session row
    // behind for the moment it exists; a reset revokes every one of them.
    expect((await reset.json()).reset).toBe(true);
    const admin = await db("user").where({ email: ADMIN_EMAIL }).first();
    expect(await db("session").where({ user_id: admin.id })).toEqual([]);

    // Both existing browser sessions are gone, so a kept cookie is useless.
    for (const cookie of [first, second]) {
      const account = await accountRoute.GET(
        new Request(`${ORIGIN}/api/account`, { headers: { cookie } }),
      );
      expect(account.status).toBe(403);
    }
    expect(await db("session").where({ token: tokenFrom(second) })).toEqual([]);

    expect((await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)).status).toBe(401);
    expect((await signIn(ADMIN_EMAIL, "operator-passphrase-2")).status).toBe(200);

    const replay = await passwordResetConfirmRoute.POST(
      jsonRequest(`${ORIGIN}/api/password-reset/confirm`, {
        token,
        newPassword: "operator-passphrase-3",
      }),
    );
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.kind).toBe("invalid-account-link");
    expect((await signIn(ADMIN_EMAIL, "operator-passphrase-3")).status).toBe(401);
  });
});

describe("POST /api/account/email", () => {
  it("only reports a confirmation, and switches identity when it is confirmed", async () => {
    await claim();
    const cookie = await adminCookie();
    await configureSmtp(cookie);

    const requested = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: "ada@example.com" }, { cookie }),
    );
    expect(requested.status).toBe(202);
    expect(await requested.json()).toEqual({ confirmationSent: true });
    expect(inbox.messages.at(-1)!.to).toEqual(["ada@example.com"]);

    // The sign-in identity has not moved yet.
    const before = await accountRoute.GET(
      new Request(`${ORIGIN}/api/account`, { headers: { cookie } }),
    );
    expect((await before.json()).user.email).toBe(ADMIN_EMAIL);

    const confirmed = await emailConfirmRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email/confirm`, { token: linkTokenFrom("/email-change/confirm") }),
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ confirmed: true, email: "ada@example.com" });

    // Every session of the old identity is revoked, and the new address signs in.
    const after = await accountRoute.GET(
      new Request(`${ORIGIN}/api/account`, { headers: { cookie } }),
    );
    expect(after.status).toBe(403);
    expect((await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)).status).toBe(401);
    const rotated = await signIn("ada@example.com", ADMIN_PASSWORD);
    expect(rotated.status).toBe(200);
    const account = await accountRoute.GET(
      new Request(`${ORIGIN}/api/account`, { headers: { cookie: sessionCookieFrom(rotated) } }),
    );
    expect((await account.json()).user.email).toBe("ada@example.com");
  });

  it("refuses to report a completed change when email is unavailable", async () => {
    await claim();
    const cookie = await adminCookie();

    const unconfigured = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: "ada@example.com" }, { cookie }),
    );
    expect(unconfigured.status).toBe(409);
    expect((await unconfigured.json()).error).toEqual({ kind: "mail-not-configured", missing: "smtp" });

    await configureSmtp(cookie, 1);
    const failing = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: "ada@example.com" }, { cookie }),
    );
    expect(failing.status).toBe(502);
    expect((await failing.json()).error.kind).toBe("mail-delivery-failed");
    expect(await db("user").where({ email: ADMIN_EMAIL })).toHaveLength(1);
    expect(await db("account_link_tokens").where({ kind: "email-change" })).toHaveLength(0);
  });

  it("needs a session and a trusted origin", async () => {
    await claim();
    const cookie = await adminCookie();

    const anonymous = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: "ada@example.com" }),
    );
    expect(anonymous.status).toBe(403);

    const crossOrigin = await emailRoute.POST(
      jsonRequest(
        `${ORIGIN}/api/account/email`,
        { newEmail: "ada@example.com" },
        { cookie, origin: "https://attacker.example" },
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.kind).toBe("invalid-origin");
  });
});

describe("administrator access", () => {
  it("has no public recovery route", async () => {
    await claim();
    await adminCookie();
    // Even a signed-in administrator cannot override a password here.
    const res = await adminRecoveryRoute.POST();
    expect(res.status).toBe(404);
    expect((await res.json()).error.kind).toBe("not-found");
    expect((await signIn(ADMIN_EMAIL, "attacker-passphrase-1")).status).toBe(401);
  });

  it("is not reachable through the identity library's own password routes", async () => {
    await claim();
    // The library mounts under /api/auth; the application never adds a reset
    // sender, so its request route reports that reset is not enabled rather
    // than mailing a link nobody asked this installation for.
    const options = getAuth().options.emailAndPassword as
      | { sendResetPassword?: unknown; revokeSessionsOnPasswordReset?: unknown }
      | undefined;
    expect(options?.sendResetPassword).toBeUndefined();
    expect(options?.revokeSessionsOnPasswordReset).toBeUndefined();
  });

  it("leaves the setup claim spent, so no second administrator can be created", async () => {
    await claim();
    const res = await claimRoute.POST(
      jsonRequest(`${ORIGIN}/api/setup/claim`, {
        token: TOKEN,
        name: "Mallory",
        email: "mallory@example.nl",
        password: "mallory-passphrase-1",
        workspaceName: "Mallory's workspace",
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.kind).toBe("setup-already-complete");
    expect(await db("user").where({ email: "mallory@example.nl" })).toHaveLength(0);
  });
});

describe("invitation acceptance provisioning", () => {
  it("creates the invited identity through the server-side provisioning path", async () => {
    await claim();
    // The same path acceptance uses, which public registration never reaches.
    const created = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
      name: "Kim Shopper",
      email: "kim@example.nl",
      password: SHOPPER_PASSWORD,
    });
    expect(await db("user").where({ id: created.userId })).toHaveLength(1);
    expect(
      await getAuth().api.signInEmail({
        body: { email: "kim@example.nl", password: SHOPPER_PASSWORD },
      }),
    ).toMatchObject({ user: { id: created.userId } });
  });
});
