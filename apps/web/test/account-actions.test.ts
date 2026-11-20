// SPDX-License-Identifier: AGPL-3.0-or-later
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { runServerAction } from "./support/server-action-scope";

// The framework's request modules read `globalThis.AsyncLocalStorage` once,
// when they first load, and fall back to a no-op without it. Server actions
// only work inside a request scope, so the real implementation is installed
// before any module that reaches the framework loads.
(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage =
  AsyncLocalStorage;

// The account screen's server actions, driven the way a submitted form drives
// them: the signed-in cookie goes in, core decides what is revoked, and the
// session cookies the action writes come back out. Sign-out-everywhere is the
// case that matters most: it must revoke every stored session of the account,
// including the caller's, and clear the cookie so the browser cannot keep
// replaying it.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "server-action-one-time-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";

let db: Knex;
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let accountRoute: typeof import("../app/api/account/route");

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      host: "localhost:3000",
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

async function claim(): Promise<void> {
  const res = await claimRoute.POST(
    jsonRequest("http://localhost:3000/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
    }),
  );
  expect(res.status).toBe(200);
}

async function signIn(): Promise<string> {
  const res = await signInRoute.POST(
    jsonRequest("http://localhost:3000/api/sign-in", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    }),
  );
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

/** The account screen's sign-out-everywhere form, submitted. */
async function signOutEverywhere() {
  const actions = await import("@/app/actions");
  const data = new FormData();
  data.set("lang", "en");
  return actions.revokeAllDevicesAction(data);
}

beforeAll(async () => {
  // The reset below must hit the same database the routes use, so the URL is
  // set before any Knex pool exists.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "server-action-test-secret-0123456789abcd";
  process.env.SETUP_TOKEN = TOKEN;

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.latest();

  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  accountRoute = await import("../app/api/account/route");
  const { getDb } = await import("@/lib/core");
  // Touch the shared pool now, so it is opened against the test database.
  await getDb().raw("select 1");
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
  const { closeAuth } = await import("@/lib/auth/session");
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

describe("sign out everywhere on the account screen", () => {
  it("revokes every session of the account and clears the cookie", async () => {
    await claim();
    const first = await signIn();
    const second = await signIn();
    expect(await db("session").where({ token: tokenFrom(first) })).toHaveLength(1);
    expect(await db("session").where({ token: tokenFrom(second) })).toHaveLength(1);

    const scope = await runServerAction(signOutEverywhere, { cookie: second });

    // Both stored sessions are gone, not just the caller's.
    expect(await db("session")).toEqual([]);
    // The browser is told to drop every session cookie, and lands on sign-in.
    const cleared = scope.setCookies.filter((cookie) =>
      cookie.startsWith("better-auth.session_token="),
    );
    expect(cleared.length).toBeGreaterThanOrEqual(1);
    for (const cookie of scope.setCookies) {
      expect(cookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    }
    expect(scope.redirect).toMatchObject({
      digest: expect.stringContaining("/sign-in"),
    });
  });

  it("leaves a replayed cookie without a stored session", async () => {
    await claim();
    const cookie = await signIn();

    const scope = await runServerAction(signOutEverywhere, { cookie });
    expect(scope.setCookies.length).toBeGreaterThan(0);

    // The cookie a client keeps replaying names a session core no longer has.
    const res = await accountRoute.GET(
      new Request("http://localhost:3000/api/account", { headers: { cookie } }),
    );
    expect(res.status).toBe(403);
  });
});
