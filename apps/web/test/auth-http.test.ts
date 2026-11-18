// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getCore, getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";

// Thin HTTP contract checks over the real identity library and PostgreSQL:
// the one-time setup claim, email/password sign-in and sign-out, and trusted
// workspace authorization for direct calls and a second workspace.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "http-contract-one-time-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";

let db: Knex;
let setupRoute: typeof import("../app/api/setup/route");
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let signOutRoute: typeof import("../app/api/sign-out/route");
let accountRoute: typeof import("../app/api/account/route");

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

function claim(body: Record<string, unknown> = {}) {
  return claimRoute.POST(
    jsonRequest("http://localhost/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
      ...body,
    }),
  );
}

/** Provision a second person the way an accepted invitation will. */
async function provisionShopper(email: string, password: string, workspaceName: string) {
  const created = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
    name: "Sam Shopper",
    email,
    password,
  });
  const [workspace] = await db("workspaces")
    .insert({ name: workspaceName, created_by_user_id: created.userId })
    .returning("id");
  await db("workspace_memberships").insert({
    workspace_id: workspace.id,
    user_id: created.userId,
    role: "owner",
  });
  return { userId: created.userId, workspaceId: workspace.id as string };
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "http-contract-test-secret-0123456789abcdef";
  process.env.SETUP_TOKEN = TOKEN;

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  setupRoute = await import("../app/api/setup/route");
  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  signOutRoute = await import("../app/api/sign-out/route");
  accountRoute = await import("../app/api/account/route");
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

describe("GET /api/setup", () => {
  it("reports setup as claimable while the operator token is unused", async () => {
    const res = await setupRoute.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ complete: false, claimable: true });
  });

  it("reports setup as complete after the claim", async () => {
    await claim();
    const res = await setupRoute.GET();
    expect(await res.json()).toEqual({ complete: true, claimable: false });
  });
});

describe("POST /api/setup/claim", () => {
  it("creates the first administrator and workspace and issues a session", async () => {
    const res = await claim();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe(ADMIN_EMAIL);
    expect(body.administrator.userId).toBe(body.user.id);

    const stored = await db("user").where({ email: ADMIN_EMAIL }).first();
    expect(stored).toBeDefined();
    expect(stored.email_verified).toBe(false);
    const credential = await db("account")
      .where({ user_id: stored.id, provider_id: "credential" })
      .first();
    expect(credential.password).not.toBe(ADMIN_PASSWORD);

    // The response carries a usable session cookie, so no SMTP step is needed.
    const cookie = sessionCookieFrom(res);
    const account = await accountRoute.GET(
      new Request("http://localhost/api/account", { headers: { cookie } }),
    );
    expect(account.status).toBe(200);
    const accountBody = await account.json();
    expect(accountBody.user.email).toBe(ADMIN_EMAIL);
    expect(accountBody.workspace.id).toBe(body.user.workspace.workspaceId);
    expect(accountBody.principalKind).toBe("administrator");
  });

  it("rejects a replay with 409 and keeps one administrator", async () => {
    expect((await claim()).status).toBe(200);

    const replay = await claim({ email: "second@example.nl", name: "Second" });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error.kind).toBe("setup-already-complete");

    const count = await db("user").count("* as count").first();
    expect(Number(count?.count)).toBe(1);
  });

  it("rejects a wrong token with 403 and leaves setup claimable", async () => {
    const res = await claim({ token: "wrong-token" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("invalid-setup-token");
    expect(await (await setupRoute.GET()).json()).toEqual({ complete: false, claimable: true });
  });

  it("rejects invalid details with 400", async () => {
    const res = await claim({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ kind: "invalid-input", field: "email" });
  });
});

describe("POST /api/sign-in and /api/sign-out", () => {
  it("signs the administrator in and out with server-verified revocation", async () => {
    const claimed = await claim();
    const claimBody = await claimed.json();

    const signIn = await signInRoute.POST(
      jsonRequest("http://localhost/api/sign-in", {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    );
    expect(signIn.status).toBe(200);
    expect((await signIn.json()).user.id).toBe(claimBody.user.id);
    const cookie = sessionCookieFrom(signIn);

    const before = await accountRoute.GET(
      new Request("http://localhost/api/account", { headers: { cookie } }),
    );
    expect(before.status).toBe(200);

    const signOut = await signOutRoute.POST(
      new Request("http://localhost/api/sign-out", { method: "POST", headers: { cookie } }),
    );
    expect(signOut.status).toBe(200);
    expect(signOut.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);

    // The cookie is rejected even when a client keeps replaying it.
    const after = await accountRoute.GET(
      new Request("http://localhost/api/account", { headers: { cookie } }),
    );
    expect(after.status).toBe(403);
    expect((await after.json()).error.kind).toBe("forbidden");
  });

  it("rejects wrong credentials with 401 and unknown emails alike", async () => {
    await claim();
    const wrong = await signInRoute.POST(
      jsonRequest("http://localhost/api/sign-in", {
        email: ADMIN_EMAIL,
        password: "wrong-passphrase-1",
      }),
    );
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error.kind).toBe("invalid-credentials");

    const unknown = await signInRoute.POST(
      jsonRequest("http://localhost/api/sign-in", {
        email: "nobody@example.nl",
        password: ADMIN_PASSWORD,
      }),
    );
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error.kind).toBe("invalid-credentials");
  });
});

describe("trusted workspace authorization", () => {
  it("refuses the account endpoint without a session", async () => {
    const res = await accountRoute.GET(new Request("http://localhost/api/account"));
    expect(res.status).toBe(403);
  });

  it("keeps two workspaces isolated through HTTP and direct core calls", async () => {
    const claimed = await claim();
    const admin = await claimed.json();
    const adminCookie = sessionCookieFrom(claimed);

    const shopper = await provisionShopper(
      "shopper@example.nl",
      "shopper-passphrase-1",
      "Shopper workspace",
    );
    const shopperSignIn = await signInRoute.POST(
      jsonRequest("http://localhost/api/sign-in", {
        email: "shopper@example.nl",
        password: "shopper-passphrase-1",
      }),
    );
    expect(shopperSignIn.status).toBe(200);
    const shopperCookie = sessionCookieFrom(shopperSignIn);

    const adminAccount = await (
      await accountRoute.GET(
        new Request("http://localhost/api/account", { headers: { cookie: adminCookie } }),
      )
    ).json();
    const shopperAccount = await (
      await accountRoute.GET(
        new Request("http://localhost/api/account", { headers: { cookie: shopperCookie } }),
      )
    ).json();

    expect(adminAccount.workspace.id).toBe(admin.user.workspace.workspaceId);
    expect(shopperAccount.workspace.id).toBe(shopper.workspaceId);
    expect(shopperAccount.principalKind).toBe("workspace");
    expect(shopperAccount.workspace.id).not.toBe(adminAccount.workspace.id);

    // A request naming the other workspace in the query string gains nothing.
    const tampered = await accountRoute.GET(
      new Request(
        `http://localhost/api/account?workspaceId=${admin.user.workspace.workspaceId}`,
        { headers: { cookie: shopperCookie } },
      ),
    );
    expect((await tampered.json()).workspace.id).toBe(shopper.workspaceId);

    // Direct core calls enforce the same rules as the transport.
    const core = getCore();
    expect(
      await core.auth.admission({
        kind: "workspace",
        userId: shopper.userId,
        workspaceId: admin.user.workspace.workspaceId,
      }),
    ).toEqual({ ok: false, error: { kind: "forbidden", capability: "workspace.read" } });
    expect(
      await core.auth.admission({
        kind: "workspace",
        userId: shopper.userId,
        workspaceId: shopper.workspaceId,
      }),
    ).toMatchObject({ ok: true, value: { workspace: { workspaceId: shopper.workspaceId } } });
    expect(await core.auth.administrator(shopper.userId)).toMatchObject({
      ok: false,
      error: { kind: "forbidden", capability: "installation.manage" },
    });
    expect(await core.auth.admission({ kind: "anonymous" })).toEqual({
      ok: false,
      error: { kind: "forbidden", capability: "workspace.read" },
    });
  });
});
