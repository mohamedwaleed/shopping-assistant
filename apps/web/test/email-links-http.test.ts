// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { SMTPServer } from "smtp-server";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { dictionaries } from "@/lib/i18n";
import type { LinkFormState } from "@/app/email-link-forms";
import { runServerAction } from "./support/server-action-scope";

// The framework's request modules read `globalThis.AsyncLocalStorage` once,
// when they first load, and fall back to a no-op without it. Server actions
// only work inside a request scope, so the real implementation is installed
// before any module that reaches the framework loads.
(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage =
  AsyncLocalStorage;

// The three email-link flows the screens complete, driven the way a browser
// drives them, over real PostgreSQL, the real identity library and a real SMTP
// conversation: the HTTP endpoint that sends a link, then the server action
// each screen's form submits. The link is read out of the delivered message, so
// the screen is exercised with the token the email really carries — never one
// the test invented — and the address the screen posts is the one the link was
// bound to.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "email-link-screens-one-time-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";
const SHOPPER_EMAIL = "shopper@example.nl";
const SHOPPER_PASSWORD = "shopper-passphrase-1";
const SMTP_USER = "smtp-user";
const SMTP_PASSWORD = "smtp-passphrase-1";
const ORIGIN = "http://localhost:3000";

interface ReceivedMessage {
  to: string[];
  raw: string;
}

/** A local test inbox: a real SMTP server, so a link is actually delivered. */
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
      if (auth.username === SMTP_USER && auth.password === SMTP_PASSWORD) {
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
let invitationRoute: typeof import("../app/api/invitations/route");
let resetRoute: typeof import("../app/api/account/password/reset/route");
let emailRoute: typeof import("../app/api/account/email/route");
let accountRoute: typeof import("../app/api/account/route");
let actions: typeof import("@/app/actions");

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
  const setCookies = response.headers.getSetCookie();
  const session = setCookies.find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!session) throw new Error(`no session cookie in ${JSON.stringify(setCookies)}`);
  return session.split(";")[0]!;
}

function tokenFrom(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
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

async function signIn(email: string, password: string): Promise<string> {
  const res = await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email, password }));
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

function account(cookie: string) {
  return accountRoute.GET(new Request(`${ORIGIN}/api/account`, { headers: { cookie } }));
}

/**
 * The newest link the installation delivered to `address` for `pathname`,
 * exactly as the recipient's screen receives it: the address and token the
 * message carries. The body is quoted-printable encoded, so `=` line breaks and
 * `=3D` escapes are undone before the URL is read.
 */
function deliveredLink(address: string, pathname: string): { email: string; token: string } {
  const message = [...inbox.messages]
    .reverse()
    .find((candidate) => candidate.to.includes(address) && candidate.raw.includes(pathname));
  if (!message) throw new Error(`no ${pathname} message was delivered to ${address}`);
  const body = message.raw.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
  const link = body.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`the message to ${address} carries no link`);
  const url = new URL(link);
  const token = url.searchParams.get("token");
  const email = url.searchParams.get("email");
  if (!token || !email) throw new Error(`the link to ${address} is missing its token or address`);
  expect(`${url.origin}${url.pathname}`).toBe(`${ORIGIN}${pathname}`);
  return { email, token };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("lang", "en");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

/** The invitation screen's form, submitted. */
function acceptInvitation(link: { email: string; token: string }, overrides: Record<string, string> = {}) {
  return runServerAction(() =>
    actions.acceptInvitationAction(
      { error: null },
      form({
        email: link.email,
        token: link.token,
        name: "Sam Shopper",
        password: SHOPPER_PASSWORD,
        workspaceName: "Sam's workspace",
        ...overrides,
      }),
    ),
  );
}

/** The reset completion screen's form, submitted. */
function completeReset(link: { email: string; token: string }, newPassword: string) {
  return runServerAction(() =>
    actions.completePasswordResetAction(
      { error: null },
      form({ email: link.email, token: link.token, password: newPassword }),
    ),
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = ORIGIN;
  process.env.BETTER_AUTH_SECRET = "email-link-screens-test-secret-0123456";
  process.env.SETUP_TOKEN = TOKEN;
  // The mailer encrypts the stored SMTP password with the installation secret.
  process.env.INSTALLATION_SECRET = "email-link-screens-installation-secret";

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.latest();
  const { getDb } = await import("@/lib/core");
  await getDb().raw("select 1");
  inbox = await startTestInbox();

  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  invitationRoute = await import("../app/api/invitations/route");
  resetRoute = await import("../app/api/account/password/reset/route");
  emailRoute = await import("../app/api/account/email/route");
  accountRoute = await import("../app/api/account/route");
  actions = await import("@/app/actions");
});

beforeEach(async () => {
  // A reset deletes every session of the account and writes a new password, so
  // each test starts from a clean installation rather than a stale account.
  await db("workspace_memberships").delete();
  await db("workspaces").delete();
  await db("session").delete();
  await db("account").delete();
  await db("user").delete();
  await db("verification").delete();
  await db("installation").update({
    setup_completed_at: null,
    setup_token_hash: null,
    setup_administrator_user_id: null,
    smtp_settings: null,
    mail_delivery: null,
  });
  inbox.messages.length = 0;

  // The administrator configures delivery exactly as the email settings screen
  // does, then the test inbox receives every link.
  await claim();
  const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const saved = await emailSettingsRoute.PUT(
    jsonRequest(
      `${ORIGIN}/api/administration/email`,
      {
        host: "127.0.0.1",
        port: inbox.port,
        secure: false,
        username: SMTP_USER,
        password: SMTP_PASSWORD,
        fromAddress: "assistant@example.nl",
        fromName: "Shopping Assistant",
        recipient: ADMIN_EMAIL,
      },
      { cookie },
    ),
  );
  expect(saved.status).toBe(200);
});

const emailSettingsRoute = await import("../app/api/administration/email/route");

afterAll(async () => {
  const { closeAuth } = await import("@/lib/auth/session");
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
  if (inbox) await new Promise<void>((resolve) => inbox.server.close(() => resolve()));
});

describe("the invitation screen completes the flow the email started", () => {
  it("creates the shopper's own workspace and refuses the same link twice", async () => {
    const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const invited = await invitationRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations`, { email: SHOPPER_EMAIL }, { cookie: adminCookie }),
    );
    expect(invited.status).toBe(200);
    const link = deliveredLink(SHOPPER_EMAIL, "/accept-invitation");

    const accepted = await acceptInvitation(link);
    expect(accepted.redirect).toBeUndefined();
    // The screen signs the new shopper in, so the account screen works at once.
    const sessionCookie = accepted.setCookies.find((cookie) =>
      cookie.startsWith("better-auth.session_token="),
    );
    expect(sessionCookie).toBeDefined();

    // The account exists with its own workspace, and the shopper is signed in.
    const admitted = await account(sessionCookie!.split(";")[0]!);
    expect(admitted.status).toBe(200);
    const shopper = await admitted.json();
    const admin = await (await account(adminCookie)).json();
    expect(shopper.workspace.id).not.toBe(admin.workspace.id);
    expect(shopper.workspace.role).toBe("owner");

    // The link is spent: replaying the same form is refused explicitly, and
    // no second account appears.
    const replayed = await acceptInvitation(link);
    expect(replayed.state).toEqual({ error: dictionaries.en.invitationInvalidBody });
    expect(await db("user").where({ email: SHOPPER_EMAIL })).toHaveLength(1);
  });

  it("refuses an expired invitation instead of creating an account", async () => {
    const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await invitationRoute.POST(
      jsonRequest(`${ORIGIN}/api/invitations`, { email: SHOPPER_EMAIL }, { cookie: adminCookie }),
    );
    const link = deliveredLink(SHOPPER_EMAIL, "/accept-invitation");
    await db("verification").where({ identifier: `invitation:${SHOPPER_EMAIL}` }).update({ expires_at: new Date(0) });

    const refused = await acceptInvitation(link);
    expect(refused.state).toEqual({ error: dictionaries.en.invitationInvalidBody });
    expect(await db("user").where({ email: SHOPPER_EMAIL })).toEqual([]);
  });
});

describe("the reset screens recover a password and revoke every session", () => {
  it("signs out every device when the link is used, and refuses the replay", async () => {
    const other = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const requested = await resetRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/password/reset`, { email: ADMIN_EMAIL }),
    );
    expect(requested.status).toBe(200);
    const link = deliveredLink(ADMIN_EMAIL, "/reset-password");

    const completed = await completeReset(link, "operator-passphrase-2");
    expect(completed.redirect).toBeUndefined();
    expect(completed.state).toEqual({ error: null, done: true });

    // Every stored session is gone, and the cookie the browser held is cleared.
    expect(await db("session").where({ token: tokenFrom(other) })).toEqual([]);
    expect(completed.setCookies.length).toBeGreaterThan(0);
    expect(completed.setCookies.every((cookie) => /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(cookie))).toBe(true);
    expect((await account(other)).status).toBe(403);

    // The new password works and the old one does not.
    expect((await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: ADMIN_EMAIL, password: "operator-passphrase-2" }))).status).toBe(200);
    expect((await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }))).status).toBe(401);

    // A replay of the same link cannot change the password again.
    const replayed = await completeReset(link, "operator-passphrase-3");
    expect(replayed.state).toEqual({ error: dictionaries.en.resetLinkInvalidBody });
    expect((await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: ADMIN_EMAIL, password: "operator-passphrase-2" }))).status).toBe(200);
  });

  it("lets only one of two concurrent submissions use the link", async () => {
    await resetRoute.POST(jsonRequest(`${ORIGIN}/api/account/password/reset`, { email: ADMIN_EMAIL }));
    const link = deliveredLink(ADMIN_EMAIL, "/reset-password");

    const submissions = await Promise.all([
      completeReset(link, "operator-passphrase-2"),
      completeReset(link, "operator-passphrase-3"),
    ]);

    // Exactly one screen reports success; the other is told the link is unusable.
    const states = submissions.map((submission) => submission.state as LinkFormState);
    expect(states.filter((state) => state.done === true)).toHaveLength(1);
    expect(states.filter((state) => state.error === dictionaries.en.resetLinkInvalidBody)).toHaveLength(1);

    // And exactly one password was applied.
    const usable = [
      await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: ADMIN_EMAIL, password: "operator-passphrase-2" })),
      await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: ADMIN_EMAIL, password: "operator-passphrase-3" })),
    ].filter((response) => response.status === 200);
    expect(usable).toHaveLength(1);
  });

  it("refuses an expired reset link", async () => {
    await resetRoute.POST(jsonRequest(`${ORIGIN}/api/account/password/reset`, { email: ADMIN_EMAIL }));
    const link = deliveredLink(ADMIN_EMAIL, "/reset-password");
    await db("verification").where({ identifier: `password-reset:${ADMIN_EMAIL}` }).update({ expires_at: new Date(0) });

    const refused = await completeReset(link, "operator-passphrase-2");
    expect(refused.state).toEqual({ error: dictionaries.en.resetLinkInvalidBody });
    expect((await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }))).status).toBe(200);
  });
});

describe("the account screen starts an email change and the link completes it", () => {
  it("keeps the sign-in address until the new mailbox confirms, and then moves it", async () => {
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const requested = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: "moved@example.nl" }, { cookie }),
    );
    expect(requested.status).toBe(200);
    // Nothing moved yet: the link is the proof of the new mailbox.
    expect(await db("user").where({ email: ADMIN_EMAIL })).toHaveLength(1);

    const link = deliveredLink("moved@example.nl", "/account/email/confirm");
    const confirmed = await runServerAction(() =>
      actions.confirmEmailChangeAction({ error: null }, form({ email: link.email, token: link.token })),
    );
    expect(confirmed.redirect).toBeUndefined();
    expect(await db("user").where({ email: "moved@example.nl" })).toHaveLength(1);

    // The new address signs in, and a replay of the link changes nothing.
    expect((await signInRoute.POST(jsonRequest(`${ORIGIN}/api/sign-in`, { email: "moved@example.nl", password: ADMIN_PASSWORD }))).status).toBe(200);
    await runServerAction(() =>
      actions.confirmEmailChangeAction({ error: null }, form({ email: link.email, token: link.token })),
    );
    expect(await db("user").where({ email: ADMIN_EMAIL })).toEqual([]);
  });

  it("requires a session from the last few minutes to start the change", async () => {
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    // Age the session past the recent-authentication window without ending it.
    const issuedAt = new Date(Date.now() - 10 * 60 * 1000);
    await db("session").where({ token: tokenFrom(cookie) }).update({ created_at: issuedAt, updated_at: new Date() });

    const refused = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: "moved@example.nl" }, { cookie }),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.kind).toBe("reauthentication-required");
    expect(inbox.messages).toEqual([]);
  });

  it("refuses the address the account already signs in with", async () => {
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const refused = await emailRoute.POST(
      jsonRequest(`${ORIGIN}/api/account/email`, { newEmail: ADMIN_EMAIL.toUpperCase() }, { cookie }),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatchObject({ kind: "invalid-input", field: "newEmail" });
    expect(inbox.messages).toEqual([]);
  });
});
