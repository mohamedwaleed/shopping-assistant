// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getCore, getDb } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { settingsPrincipal } from "@/lib/models/request";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { startProviderFixtures, type ProviderFixture } from "./support/provider-fixtures";

// Thin HTTP contract checks for model settings: the administrator-only
// installation default, the per-workspace override, the bounded diagnostic and
// the guarantee that no credential ever leaves the server.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "model-settings-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";
const INSTALLATION_KEY = "sk-installation-http-key-0001";
const WORKSPACE_KEY = "fixture-workspace-http-key-0001";

let db: Knex;
let fixtures: ProviderFixture;
let setupRoute: typeof import("../app/api/settings/models/route");
let testRoute: typeof import("../app/api/settings/models/test/route");
let workspaceRoute: typeof import("../app/api/settings/models/workspace/route");
let budgetRoute: typeof import("../app/api/settings/budgets/route");
let budgetTestRoute: typeof import("../app/api/settings/budgets/test/route");
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let ingestRoute: typeof import("../app/api/catalogue/ingest/route");

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
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

/** Every log sink the app can reach, so redaction is proven, not assumed. */
function captureLogs() {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  return lines;
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "model-settings-test-secret-0123456789abcdef";
  process.env.INSTALLATION_SECRET = "model-settings-installation-secret-0123";
  process.env.SETUP_TOKEN = TOKEN;

  fixtures = await startProviderFixtures();
  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  setupRoute = await import("../app/api/settings/models/route");
  testRoute = await import("../app/api/settings/models/test/route");
  workspaceRoute = await import("../app/api/settings/models/workspace/route");
  budgetRoute = await import("../app/api/settings/budgets/route");
  budgetTestRoute = await import("../app/api/settings/budgets/test/route");
  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  ingestRoute = await import("../app/api/catalogue/ingest/route");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  fixtures.reset();
  await db("provider_budget_reservations").delete();
  await db("workspace_provider_budget_usage").delete();
  await db("workspace_provider_budget_settings").delete();
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

describe("model settings over HTTP", () => {
  it("shows saved budget usage and a pause reason through settings and test execution", async () => {
    const cookie = await claimAdministrator();
    const saved = await budgetRoute.PUT(jsonRequest("http://localhost/api/settings/budgets", { scope: "installation", interactiveCents: 10, backgroundCents: 5, maxInteractive: 1, maxBackground: 1, retryLimit: 0, paidFallbackEnabled: false }, { cookie }));
    expect(saved.status).toBe(200);
    const exhausted = await budgetTestRoute.POST(jsonRequest("http://localhost/api/settings/budgets/test", { kind: "interactive", estimatedCents: 11, usageSource: "installation" }, { cookie }));
    expect(exhausted.status).toBe(409);
    expect((await exhausted.json()).error).toMatchObject({ kind: "budget-paused", reason: "allowance" });
    const owner = await db("workspace_memberships").first();
    await db("workspace_provider_budget_usage").insert({ workspace_id: owner.workspace_id, kind: "interactive", settled_cents: 10, reserved_cents: 0 });
    const read = await budgetRoute.GET(new Request("http://localhost/api/settings/budgets", { headers: { cookie } }));
    expect(read.status).toBe(200);
    expect((await read.json()).pauseReasons).toMatchObject({ interactive: "allowance" });
  });

  it("maps a submitted unsafe catalogue URL to a core 400 without fetching it", async () => {
    const cookie = await claimAdministrator();
    const response = await ingestRoute.POST(
      jsonRequest("http://localhost/api/catalogue/ingest", { url: "http://127.0.0.1/private" }, { cookie }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.kind).toBe("unsafe-url");
  });
  it("requires a session", async () => {
    const res = await setupRoute.GET(new Request("http://localhost/api/settings/models"));
    expect(res.status).toBe(403);
    expect((await res.json()).error.kind).toBe("forbidden");
  });

  it("stores the installation default and never returns the key", async () => {
    const cookie = await claimAdministrator();
    const logs = captureLogs();

    const save = await setupRoute.PUT(
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
        { cookie },
      ),
    );
    expect(save.status).toBe(200);
    const saveBody = await save.json();
    expect(saveBody.installation.defaultModel.modelId).toBe("fixture-model-complete");
    expect(saveBody.installation.credential).toEqual({
      source: "installation",
      masked: "sk-…001",
    });

    const read = await setupRoute.GET(
      new Request("http://localhost/api/settings/models", { headers: { cookie } }),
    );
    expect(read.status).toBe(200);
    const readText = await read.text();
    expect(readText).not.toContain(INSTALLATION_KEY);
    expect(readText).not.toContain("ciphertext");
    expect(JSON.parse(readText)).toMatchObject({
      installation: { usageSource: "installation" },
      diagnostics: { bounds: { maxCalls: 4, maxOutputTokens: 64 } },
    });

    expect(logs.join("\n")).not.toContain(INSTALLATION_KEY);
  });

  it("refuses installation changes from a workspace member", async () => {
    await claimAdministrator();
    await provisionShopper("shopper@example.nl", "shopper-passphrase-1", "Shopper workspace");
    const shopperCookie = await signIn("shopper@example.nl", "shopper-passphrase-1");

    const save = await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
          usageSource: "installation",
          extractionModel: null,
          apiKey: "sk-shopper-attempt-0001",
        },
        { cookie: shopperCookie },
      ),
    );
    expect(save.status).toBe(403);
    expect((await save.json()).error.kind).toBe("forbidden");

    const test = await testRoute.POST(
      jsonRequest("http://localhost/api/settings/models/test", {}, { cookie: shopperCookie }),
    );
    expect(test.status).toBe(403);
  });

  it("keeps two workspaces isolated and shows each only its own override", async () => {
    const adminCookie = await claimAdministrator();
    await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
          usageSource: "installation",
          extractionModel: null,
          apiKey: INSTALLATION_KEY,
        },
        { cookie: adminCookie },
      ),
    );

    const shopper = await provisionShopper(
      "shopper@example.nl",
      "shopper-passphrase-1",
      "Shopper workspace",
    );
    const shopperCookie = await signIn("shopper@example.nl", "shopper-passphrase-1");

    const override = await workspaceRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models/workspace",
        {
          defaultModel: {
            provider: "compatible",
            modelId: "fixture-model-complete",
            endpoint: `${fixtures.baseUrl}/compatible/v1`,
          },
          usageSourceChoice: "workspace",
          extractionModel: null,
          apiKey: WORKSPACE_KEY,
        },
        { cookie: shopperCookie },
      ),
    );
    expect(override.status).toBe(200);
    const overrideText = await override.text();

    expect(overrideText).not.toContain(WORKSPACE_KEY);
    expect(overrideText).not.toContain(INSTALLATION_KEY);

    const shopperView = await (
      await setupRoute.GET(
        new Request("http://localhost/api/settings/models", { headers: { cookie: shopperCookie } }),
      )
    ).json();
    expect(shopperView.workspace.defaultModel.provider).toBe("compatible");
    expect(shopperView.effective).toMatchObject({ source: "workspace", usageSource: "workspace" });

    const adminView = await (
      await setupRoute.GET(
        new Request("http://localhost/api/settings/models", { headers: { cookie: adminCookie } }),
      )
    ).json();
    expect(adminView.workspace).toBeNull();
    expect(adminView.effective).toMatchObject({ source: "installation", usageSource: "installation" });

    // A tampered workspace identifier in the request body or query gains nothing.
    const tampered = await workspaceRoute.PUT(
      jsonRequest(
        `http://localhost/api/settings/models/workspace?workspaceId=${shopper.workspaceId}`,
        {
          workspaceId: shopper.workspaceId,
          defaultModel: { provider: "openai", modelId: "gpt-5.1-mini" },
          usageSource: "installation",
          extractionModel: null,
          apiKey: null,
        },
        { cookie: adminCookie },
      ),
    );
    expect(tampered.status).toBe(200);
    const untouched = await db("workspace_model_settings")
      .where({ workspace_id: shopper.workspaceId })
      .first();
    expect(JSON.parse(untouched.default_model).provider).toBe("compatible");
  });

  it("runs the bounded capability test against the configured endpoint", async () => {
    const cookie = await claimAdministrator();
    await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: {
            provider: "compatible",
            modelId: "fixture-model-no-tools",
            endpoint: `${fixtures.baseUrl}/compatible/v1`,
          },
          usageSource: "installation",
          extractionModel: null,
          apiKey: INSTALLATION_KEY,
        },
        { cookie },
      ),
    );
    const logs = captureLogs();

    const res = await testRoute.POST(
      jsonRequest(
        "http://localhost/api/settings/models/test",
        { maxCalls: 4, maxOutputTokens: 32 },
        { cookie },
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capability.capabilities).toMatchObject({
      text: "supported",
      tools: "unsupported",
      structuredOutput: "supported",
      streaming: "supported",
    });
    expect(body.capability.bounds).toEqual({ maxCalls: 4, maxOutputTokens: 32 });
    const text = JSON.stringify(body);
    expect(text).not.toContain(INSTALLATION_KEY);
    expect(logs.join("\n")).not.toContain(INSTALLATION_KEY);

    // Out-of-bounds diagnostics are rejected before any provider call.
    fixtures.reset();
    const rejected = await testRoute.POST(
      jsonRequest(
        "http://localhost/api/settings/models/test",
        { maxCalls: 100, maxOutputTokens: 32 },
        { cookie },
      ),
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toMatchObject({ kind: "invalid-input", field: "maxCalls" });
    expect(fixtures.requests).toEqual([]);
  });

  it("reports a missing model loudly instead of falling back", async () => {
    const cookie = await claimAdministrator();
    const res = await testRoute.POST(
      jsonRequest("http://localhost/api/settings/models/test", {}, { cookie }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ kind: "model-not-configured", role: "default" });
    expect(fixtures.requests).toEqual([]);
  });

  it("surfaces the provider-mismatch guard as a typed 409 error", async () => {
    const cookie = await claimAdministrator();
    // The key is openai's, but extraction is overridden onto an Anthropic
    // model: resolving that role must refuse rather than borrow the key.
    const saved = await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
          usageSource: "installation",
          extractionModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
          apiKey: INSTALLATION_KEY,
        },
        { cookie },
      ),
    );
    expect(saved.status).toBe(200);

    const principal = await settingsPrincipal(
      new Request("http://localhost/api/settings/models", { headers: { cookie } }),
    );
    expect(principal).not.toBeNull();
    const resolved = await getCore().models.resolve(principal!, "extraction");
    expect(resolved).toEqual({
      ok: false,
      error: {
        kind: "model-credential-provider-mismatch",
        provider: "anthropic",
        credentialProvider: "openai",
        source: "installation",
      },
    });

    // The error kind maps to a conflict the browser can render, not a 500.
    expect(
      errorResponse({
        kind: "model-credential-provider-mismatch",
        provider: "anthropic",
        credentialProvider: "openai",
        source: "installation",
      }).status,
    ).toBe(409);
    // Nothing was ever sent: the openai key never reached the Anthropic model.
    expect(fixtures.requests).toEqual([]);
  });

  it("rejects invalid model targets with 400", async () => {
    const cookie = await claimAdministrator();
    const res = await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "compatible", modelId: "local" },
          usageSource: "installation",
          extractionModel: null,
          apiKey: null,
        },
        { cookie },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ kind: "invalid-input", field: "defaultModel" });
  });
});
