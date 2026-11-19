// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getCore, getDb } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { startProviderFixtures, type ProviderFixture } from "./support/provider-fixtures";

// Thin HTTP contract checks for budgets: allowances, separate pools, the
// personal-key consent, and the guarantee that a paused budget returns a typed
// error rather than calling a provider.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "budget-settings-setup-token";
const ADMIN_EMAIL = "budget-operator@example.nl";
const ADMIN_PASSWORD = "budget-operator-passphrase-1";
const INSTALLATION_KEY = "sk-budget-installation-key-0001";
const WORKSPACE_KEY = "fixture-budget-workspace-key-0001";

let db: Knex;
let fixtures: ProviderFixture;
let budgetsRoute: typeof import("../app/api/settings/budgets/route");
let consentRoute: typeof import("../app/api/settings/budgets/consent/route");
let modelsRoute: typeof import("../app/api/settings/models/route");
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");

function jsonRequest(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookieFrom(response: Response): string {
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!session) throw new Error("no session cookie issued");
  return session.split(";")[0]!;
}

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

async function signIn(email: string, password: string): Promise<string> {
  const res = await signInRoute.POST(
    jsonRequest("http://localhost/api/sign-in", { email, password }),
  );
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "budget-settings-test-secret-0123456789abcdef";
  process.env.INSTALLATION_SECRET = "budget-settings-installation-secret-0123";
  process.env.SETUP_TOKEN = TOKEN;

  fixtures = await startProviderFixtures();
  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  budgetsRoute = await import("../app/api/settings/budgets/route");
  consentRoute = await import("../app/api/settings/budgets/consent/route");
  modelsRoute = await import("../app/api/settings/models/route");
  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  fixtures.reset();
  await db("budget_reservations").delete();
  await db("budget_periods").delete();
  await db("budget_allowances").delete();
  await db("workspace_budget_permissions").delete();
  await db("workspace_personal_key_consents").delete();
  await db("workspace_model_settings").delete();
  await db("workspace_model_credentials").delete();
  await db("installation_model_settings").update({
    default_model: null,
    extraction_model: null,
    usage_source: null,
    capability_report: null,
    capability_tested_at: null,
  });
  await db("installation_model_credentials").delete();
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
  await fixtures.close();
  await db.destroy();
});

async function claimAdministrator(): Promise<string> {
  const res = await claimRoute.POST(
    jsonRequest("http://localhost/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
    }),
  );
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

describe("budgets over HTTP", () => {
  it("requires a session", async () => {
    const res = await budgetsRoute.GET(new Request("http://localhost/api/settings/budgets"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("forbidden");
  });

  it("reports both pools, the disclosed estimate and no paid fallback", async () => {
    const cookie = await claimAdministrator();
    const res = await budgetsRoute.GET(
      new Request("http://localhost/api/settings/budgets", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pools.map((pool: { pool: string }) => pool.pool)).toEqual([
      "interactive",
      "background",
    ]);
    expect(body.pools[0].effective).toEqual({ maxCalls: 60, maxTokens: 120_000, maxCents: 500 });
    expect(body.pools[1].effective).toEqual({ maxCalls: 20, maxTokens: 40_000, maxCents: 150 });
    expect(body.pools.every((pool: { paused: unknown }) => pool.paused === null)).toBe(true);
    // The conservative estimate is disclosed, and no paid fallback is implied.
    expect(body.estimates.basis).toBe("conservative");
    expect(body.estimates.assumption).toContain("conservative estimate");
    expect(body.fallback).toEqual({ paidAllowed: false, workspaceMayRequest: false });
    expect(body.consent).toEqual({ backgroundPersonalKey: false });
  });

  it("lets an administrator set a ceiling and clamps a workspace override to it", async () => {
    const adminCookie = await claimAdministrator();
    const ceiling = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { installation: { pool: "interactive", maxCalls: 3, maxTokens: 50_000, maxCents: 50 } },
        { cookie: adminCookie },
        "PUT",
      ),
    );
    expect(ceiling.status).toBe(200);
    expect((await ceiling.json()).pools[0].installation).toEqual({
      maxCalls: 3,
      maxTokens: 50_000,
      maxCents: 50,
    });

    const shopper = await provisionShopper(
      "budget-shopper@example.nl",
      "budget-shopper-passphrase-1",
      "Budget shopper workspace",
    );
    const shopperCookie = await signIn("budget-shopper@example.nl", "budget-shopper-passphrase-1");

    // Without the administrator allowing it, the override is not applied.
    const blocked = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { workspace: { pool: "interactive", maxCalls: 400, maxTokens: 900_000, maxCents: 9_000 } },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(blocked.status).toBe(200);
    expect((await blocked.json()).pools[0].workspace).toBeNull();

    const permitted = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { workspaceId: shopper.workspaceId, workspaceOverrideAllowed: true },
        { cookie: adminCookie },
        "PUT",
      ),
    );
    expect(permitted.status).toBe(200);

    const clamped = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { workspace: { pool: "interactive", maxCalls: 400, maxTokens: 900_000, maxCents: 9_000 } },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(clamped.status).toBe(200);
    const pool = (await clamped.json()).pools[0];
    expect(pool.workspace).toEqual({ maxCalls: 3, maxTokens: 50_000, maxCents: 50 });
    expect(pool.effective).toEqual({ maxCalls: 3, maxTokens: 50_000, maxCents: 50 });
  });

  it("refuses installation changes and cross-workspace grants from a member", async () => {
    await claimAdministrator();
    const shopper = await provisionShopper(
      "budget-shopper@example.nl",
      "budget-shopper-passphrase-1",
      "Budget shopper workspace",
    );
    const shopperCookie = await signIn("budget-shopper@example.nl", "budget-shopper-passphrase-1");

    const ceiling = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { installation: { pool: "interactive", maxCalls: 3, maxTokens: 50_000, maxCents: 50 } },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(ceiling.status).toBe(403);
    expect((await ceiling.json()).error).toEqual({
      kind: "forbidden",
      capability: "installation.manage",
    });

    const grant = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { workspaceId: shopper.workspaceId, workspaceOverrideAllowed: true },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(grant.status).toBe(403);
  });

  it("records and revokes personal-key background consent", async () => {
    const adminCookie = await claimAdministrator();
    await modelsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: {
            provider: "compatible",
            modelId: "fixture-model-complete",
            endpoint: `${fixtures.baseUrl}/compatible/v1`,
          },
          usageSource: "installation",
          extractionModel: null,
          apiKey: INSTALLATION_KEY,
        },
        { cookie: adminCookie },
        "PUT",
      ),
    );
    await provisionShopper(
      "budget-shopper@example.nl",
      "budget-shopper-passphrase-1",
      "Budget shopper workspace",
    );
    const shopperCookie = await signIn("budget-shopper@example.nl", "budget-shopper-passphrase-1");

    const granted = await consentRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets/consent",
        { backgroundAllowed: true },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(granted.status).toBe(200);
    expect((await granted.json()).consent).toEqual({ backgroundPersonalKey: true });

    const revoked = await consentRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets/consent",
        { backgroundAllowed: false },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).consent).toEqual({ backgroundPersonalKey: false });

    const malformed = await consentRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets/consent",
        { backgroundAllowed: "yes" },
        { cookie: shopperCookie },
        "PUT",
      ),
    );
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toMatchObject({
      kind: "invalid-input",
      field: "backgroundAllowed",
    });
  });

  it("maps a spent allowance to 429 and makes no provider call", async () => {
    const adminCookie = await claimAdministrator();
    await modelsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: {
            provider: "compatible",
            modelId: "fixture-model-complete",
            endpoint: `${fixtures.baseUrl}/compatible/v1`,
          },
          usageSource: "installation",
          extractionModel: null,
          apiKey: INSTALLATION_KEY,
        },
        { cookie: adminCookie },
        "PUT",
      ),
    );
    await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { installation: { pool: "interactive", maxCalls: 0, maxTokens: 1_000, maxCents: 10 } },
        { cookie: adminCookie },
        "PUT",
      ),
    );

    // A zero-call allowance pauses the pool immediately; the usage view says why.
    const view = await (
      await budgetsRoute.GET(
        new Request("http://localhost/api/settings/budgets", { headers: { cookie: adminCookie } }),
      )
    ).json();
    expect(view.pools[0].paused).toEqual({
      pool: "interactive",
      reason: "calls-exhausted",
      unit: "calls",
      limit: 0,
      used: 0,
    });

    // The error kind maps to a status the browser can render, not a 500.
    expect(
      errorResponse({
        kind: "budget-exhausted",
        pool: "interactive",
        reason: "calls-exhausted",
        unit: "calls",
        limit: 0,
        used: 0,
      }).status,
    ).toBe(429);
    expect(fixtures.requests).toEqual([]);
  });

  it("rejects a malformed allowance with 400", async () => {
    const cookie = await claimAdministrator();
    const res = await budgetsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/budgets",
        { installation: { pool: "interactive", maxCalls: "lots", maxTokens: 1, maxCents: 1 } },
        { cookie },
        "PUT",
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ kind: "invalid-input", field: "installation" });
  });
});
