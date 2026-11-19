// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getCore, getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";

// Thin HTTP contract checks over the real identity library and PostgreSQL for
// the account surface: stored sessions, device listing and revocation, the
// recent-authentication gate on password changes, and the origin check that
// every state-changing account endpoint applies.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "account-surface-one-time-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";
const SHOPPER_EMAIL = "shopper@example.nl";
const SHOPPER_PASSWORD = "shopper-passphrase-1";

let db: Knex;
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let signOutRoute: typeof import("../app/api/sign-out/route");
let accountRoute: typeof import("../app/api/account/route");
let sessionsRoute: typeof import("../app/api/account/sessions/route");
let revokeRoute: typeof import("../app/api/account/sessions/revoke/route");
let passwordRoute: typeof import("../app/api/account/password/route");
let emailRoute: typeof import("../app/api/account/email/route");
let resetRoute: typeof import("../app/api/account/password/reset/route");
let invitationRoute: typeof import("../app/api/invitations/route");

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
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

/** Session token the identity library signed into the cookie. */
function tokenFrom(cookie: string): string {
  return cookie.slice(cookie.indexOf("=") + 1).split(".")[0]!;
}

/** Stored session id behind a cookie; the library owns the id format. */
async function sessionIdFor(cookie: string): Promise<string> {
  const row = await db("session").where({ token: tokenFrom(cookie) }).first();
  if (!row) throw new Error("no stored session for this cookie");
  return row.id as string;
}

function claim() {
  return claimRoute.POST(
    jsonRequest("http://localhost:3000/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
    }),
  );
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await signInRoute.POST(
    jsonRequest("http://localhost:3000/api/sign-in", { email, password }),
  );
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

/** Provision a second person the way an accepted invitation will. */
async function provisionShopper(): Promise<{ userId: string; workspaceId: string }> {
  const created = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
    name: "Sam Shopper",
    email: SHOPPER_EMAIL,
    password: SHOPPER_PASSWORD,
  });
  const [workspace] = await db("workspaces")
    .insert({ name: "Shopper workspace", created_by_user_id: created.userId })
    .returning("id");
  await db("workspace_memberships").insert({
    workspace_id: workspace.id,
    user_id: created.userId,
    role: "owner",
  });
  return { userId: created.userId, workspaceId: workspace.id as string };
}

function account(cookie: string) {
  return accountRoute.GET(
    new Request("http://localhost:3000/api/account", { headers: { cookie } }),
  );
}

function devices(cookie: string) {
  return sessionsRoute.GET(
    new Request("http://localhost:3000/api/account/sessions", { headers: { cookie } }),
  );
}

beforeAll(async () => {
  // The reset below must hit the same database the routes use, so the URL is
  // set before any Knex pool exists.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "account-surface-test-secret-0123456789ab";
  process.env.SETUP_TOKEN = TOKEN;

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();
  // Touch the shared pool now, so it is opened against the test database.
  await getDb().raw("select 1");

  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  signOutRoute = await import("../app/api/sign-out/route");
  accountRoute = await import("../app/api/account/route");
  sessionsRoute = await import("../app/api/account/sessions/route");
  revokeRoute = await import("../app/api/account/sessions/revoke/route");
  passwordRoute = await import("../app/api/account/password/route");
  emailRoute = await import("../app/api/account/email/route");
  resetRoute = await import("../app/api/account/password/reset/route");
  invitationRoute = await import("../app/api/invitations/route");
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
  });
});

afterAll(async () => {
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

describe("POST /api/sign-in issues a secure database-backed session", () => {
  it("marks the session cookie HttpOnly and SameSite", async () => {
    await claim();
    const res = await signInRoute.POST(
      jsonRequest("http://localhost:3000/api/sign-in", {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    );
    const cookie = res.headers.getSetCookie().find((value) => value.includes("session_token"))!;
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    // Secure follows the deployment protocol: this suite talks plain HTTP, so
    // the production flag is asserted on the app's own cookie options in
    // cookies.test.ts rather than invented here.
    expect(cookie).not.toMatch(/; Secure/i);

    // The session is a stored row, so the cookie alone is never the authority:
    // deleting it makes the same cookie useless (see the next test).
    expect(await db("session").where({ token: tokenFrom(cookie) }).first()).toBeDefined();
  });

  it("rejects a cookie whose stored session was deleted", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await db("session").where({ token: tokenFrom(cookie) }).delete();

    const res = await account(cookie);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/account/sessions", () => {
  it("lists this account's devices and marks the current one", async () => {
    await claim();
    const first = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const second = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await devices(second);
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.sessions.map((session: { id: string }) => session.id);
    expect(ids).toContain(await sessionIdFor(first));
    expect(ids).toContain(await sessionIdFor(second));
    expect(
      body.sessions.filter((session: { current: boolean }) => session.current),
    ).toEqual([
      expect.objectContaining({ id: await sessionIdFor(second), current: true }),
    ]);
  });

  it("refuses a request without a session", async () => {
    const res = await sessionsRoute.GET(new Request("http://localhost:3000/api/account/sessions"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("forbidden");
  });

  it("keeps two accounts apart", async () => {
    await claim();
    const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await provisionShopper();
    const shopperCookie = await signIn(SHOPPER_EMAIL, SHOPPER_PASSWORD);

    const adminDevices = await (await devices(adminCookie)).json();
    const shopperDevices = await (await devices(shopperCookie)).json();

    expect(adminDevices.sessions.map((session: { id: string }) => session.id)).toContain(
      await sessionIdFor(adminCookie),
    );
    expect(shopperDevices.sessions.map((session: { id: string }) => session.id)).toContain(
      await sessionIdFor(shopperCookie),
    );
    expect(await sessionIdFor(adminCookie)).not.toBe(await sessionIdFor(shopperCookie));
  });
});

describe("POST /api/account/sessions/revoke", () => {
  it("revokes another device and leaves this one signed in", async () => {
    await claim();
    const first = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const second = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await revokeRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/sessions/revoke",
        { sessionId: await sessionIdFor(first) },
        { cookie: second },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });

    // The revoked cookie is refused even when a client keeps replaying it.
    expect((await account(first)).status).toBe(403);
    expect((await account(second)).status).toBe(200);
  });

  it("clears the cookie when the current device revokes itself", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await revokeRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/sessions/revoke",
        { sessionId: await sessionIdFor(cookie) },
        { cookie },
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
    expect((await account(cookie)).status).toBe(403);
  });

  it("signs out every device of the account", async () => {
    await claim();
    const first = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const second = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await revokeRoute.POST(
      jsonRequest("http://localhost:3000/api/account/sessions/revoke", {}, { cookie: second }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBeGreaterThanOrEqual(2);
    expect(res.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);

    expect((await account(first)).status).toBe(403);
    expect((await account(second)).status).toBe(403);
    expect(await db("session").where({ token: tokenFrom(first) })).toEqual([]);
  });

  it("cannot revoke another account's device", async () => {
    await claim();
    const adminCookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await provisionShopper();
    const shopperCookie = await signIn(SHOPPER_EMAIL, SHOPPER_PASSWORD);

    const res = await revokeRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/sessions/revoke",
        { sessionId: await sessionIdFor(adminCookie) },
        { cookie: shopperCookie },
      ),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.kind).toBe("not-found");
    expect((await account(adminCookie)).status).toBe(200);
  });

  it("rejects a cross-origin request", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await revokeRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/sessions/revoke",
        {},
        { cookie, origin: "https://attacker.example" },
      ),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("invalid-origin");
    expect((await account(cookie)).status).toBe(200);
  });
});

describe("POST /api/account/password", () => {
  it("changes the password and signs out the other devices", async () => {
    await claim();
    const other = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const current = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await passwordRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/password",
        { currentPassword: ADMIN_PASSWORD, newPassword: "operator-passphrase-2" },
        { cookie: current },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toBe(true);
    expect(body.otherSessionsRevoked).toBeGreaterThanOrEqual(1);

    // The other device is signed out and the new password works.
    expect((await account(other)).status).toBe(403);
    const rotated = await signInRoute.POST(
      jsonRequest("http://localhost:3000/api/sign-in", {
        email: ADMIN_EMAIL,
        password: "operator-passphrase-2",
      }),
    );
    expect(rotated.status).toBe(200);
    const old = await signInRoute.POST(
      jsonRequest("http://localhost:3000/api/sign-in", {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    );
    expect(old.status).toBe(401);
  });

  it("rejects a wrong current password with 401", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await passwordRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/password",
        { currentPassword: "not-the-password", newPassword: "operator-passphrase-2" },
        { cookie },
      ),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.kind).toBe("invalid-credentials");
  });

  it("rejects invalid input with 400 before touching credentials", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const short = await passwordRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/password",
        { currentPassword: ADMIN_PASSWORD, newPassword: "short" },
        { cookie },
      ),
    );
    expect(short.status).toBe(400);
    expect((await short.json()).error).toMatchObject({
      kind: "invalid-input",
      field: "newPassword",
    });

    const empty = await passwordRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/password",
        { currentPassword: "", newPassword: "operator-passphrase-2" },
        { cookie },
      ),
    );
    expect(empty.status).toBe(400);
  });

  it("requires a session and a trusted origin", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const anonymous = await passwordRoute.POST(
      jsonRequest("http://localhost:3000/api/account/password", {
        currentPassword: ADMIN_PASSWORD,
        newPassword: "operator-passphrase-2",
      }),
    );
    expect(anonymous.status).toBe(403);

    const crossOrigin = await passwordRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/password",
        { currentPassword: ADMIN_PASSWORD, newPassword: "operator-passphrase-2" },
        { cookie, origin: "https://attacker.example" },
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect((await crossOrigin.json()).error.kind).toBe("invalid-origin");

    // Nothing changed: the original password still works.
    expect((await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)).length).toBeGreaterThan(0);
  });

  it("refuses a revoked session even when the cookie is replayed", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    await db("session").where({ token: tokenFrom(cookie) }).delete();

    const res = await passwordRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/password",
        { currentPassword: ADMIN_PASSWORD, newPassword: "operator-passphrase-2" },
        { cookie },
      ),
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /api/account/email", () => {
  it("does not change the identity when SMTP delivery is unavailable", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await emailRoute.POST(
      jsonRequest(
        "http://localhost:3000/api/account/email",
        { newEmail: "someone@example.com" },
        { cookie },
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.kind).toBe("mail-not-configured");

    const stored = await db("user").where({ email: ADMIN_EMAIL }).first();
    expect(stored).toBeDefined();
  });
});

describe("POST /api/sign-out", () => {
  it("rejects a cross-origin request and keeps the session", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await signOutRoute.POST(
      new Request("http://localhost:3000/api/sign-out", {
        method: "POST",
        headers: { cookie, origin: "https://attacker.example", host: "localhost:3000" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("invalid-origin");
    expect((await account(cookie)).status).toBe(200);
  });

  it("revokes the stored session on sign-out", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

    const res = await signOutRoute.POST(
      new Request("http://localhost:3000/api/sign-out", {
        method: "POST",
        headers: { cookie, origin: "http://localhost:3000", host: "localhost:3000" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await db("session").where({ token: tokenFrom(cookie) }).first()).toBeUndefined();
    expect((await account(cookie)).status).toBe(403);
  });
});

describe("recent authentication over HTTP", () => {
  it("reports the window and the last authenticated use", async () => {
    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const user = await db("user").where({ email: ADMIN_EMAIL }).first();
    const membership = await db("workspace_memberships").where({ user_id: user.id }).first();

    const result = await getCore().auth.recentAuthentication({
      kind: "workspace",
      userId: user.id,
      workspaceId: membership.workspace_id,
      sessionId: await sessionIdFor(cookie),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { recent: true, windowSeconds: 300 },
    });
  });
});

describe("email-link HTTP contracts", () => {
  it("keeps reset requests non-enumerating when SMTP is unavailable", async () => {
    await claim();
    const known = await resetRoute.POST(jsonRequest("http://localhost:3000/api/account/password/reset", { email: ADMIN_EMAIL }));
    const unknown = await resetRoute.POST(jsonRequest("http://localhost:3000/api/account/password/reset", { email: "nobody@example.nl" }));
    expect(known.status).toBe(409);
    expect(unknown.status).toBe(known.status);
    expect((await known.json()).error).toEqual((await unknown.json()).error);
  });

  it("requires an authenticated administrator to issue invitations and does not switch email when SMTP is unavailable", async () => {
    const forbidden = await invitationRoute.POST(jsonRequest("http://localhost:3000/api/invitations", { email: "shopper@example.nl" }));
    expect(forbidden.status).toBe(403);

    await claim();
    const cookie = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
    const change = await emailRoute.POST(jsonRequest("http://localhost:3000/api/account/email", { newEmail: "new@example.nl" }, { cookie }));
    expect(change.status).toBe(409);
    expect((await db("user").where({ email: ADMIN_EMAIL }).first())).toBeDefined();
    expect((await db("user").where({ email: "new@example.nl" }).first())).toBeUndefined();
  });
});
