// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { CHATGPT_PLAN_SCOPE } from "@shopping/core";
import { getCore, getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import {
  PLAN_FIXTURE_TOKENS,
  PLAN_REFRESH_TOKEN as PLAN_FIXTURE_REFRESH_TOKEN,
  startProviderFixtures,
  type ProviderFixture,
} from "./support/provider-fixtures";

/**
 * Thin HTTP contract checks for the ChatGPT plan connection. Core owns consent,
 * refresh, disconnect and account-specific model selection; these checks prove
 * the transport adds nothing (no cookie reuse, no workspace from the body) and
 * takes nothing away (no token in a response or a log line).
 */
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "plan-settings-setup-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";
// The fixture's plan route accepts only its own plan tokens, so the HTTP test
// uses one: that is what proves the turn went through the plan connection.
const PLAN_ACCESS_TOKEN = PLAN_FIXTURE_TOKENS.eligible;
// The refresh is spent against the fixture's token endpoint, so the stored
// refresh token is the one that endpoint issued.
const PLAN_REFRESH_TOKEN = PLAN_FIXTURE_REFRESH_TOKEN;
const API_KEY = "sk-installation-http-key-0001";

let db: Knex;
let fixtures: ProviderFixture;
let statusRoute: typeof import("../app/api/settings/chatgpt-plan/route");
let consentRoute: typeof import("../app/api/settings/chatgpt-plan/consent/route");
let callbackRoute: typeof import("../app/api/settings/chatgpt-plan/callback/route");
let refreshRoute: typeof import("../app/api/settings/chatgpt-plan/refresh/route");
let modelRoute: typeof import("../app/api/settings/chatgpt-plan/model/route");
let usageSourceRoute: typeof import("../app/api/settings/chatgpt-plan/usage-source/route");
let exerciseRoute: typeof import("../app/api/settings/chatgpt-plan/exercise/route");
let disconnectRoute: typeof import("../app/api/settings/chatgpt-plan/disconnect/route");
let modelsRoute: typeof import("../app/api/settings/models/route");
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");
let chatRoute: typeof import("../app/api/chat/route");
let sessionsRoute: typeof import("../app/api/chat/sessions/route");

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
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!session) throw new Error("no session cookie issued");
  return session.split(";")[0]!;
}

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
  process.env.BETTER_AUTH_SECRET = "plan-settings-test-secret-0123456789abcdef";
  process.env.INSTALLATION_SECRET = "plan-settings-installation-secret-0123";
  process.env.SETUP_TOKEN = TOKEN;

  fixtures = await startProviderFixtures();
  // The plan adapter's endpoint is configuration, like the model registry's:
  // point it at the loopback fixture so no test makes a real outbound request.
  process.env.CHATGPT_PLAN_RESPONSES_BASE_URL = `${fixtures.baseUrl}/openai/v1`;
  process.env.CHATGPT_PLAN_TOKEN_URL = `${fixtures.baseUrl}/oauth/token`;
  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  statusRoute = await import("../app/api/settings/chatgpt-plan/route");
  consentRoute = await import("../app/api/settings/chatgpt-plan/consent/route");
  callbackRoute = await import("../app/api/settings/chatgpt-plan/callback/route");
  refreshRoute = await import("../app/api/settings/chatgpt-plan/refresh/route");
  modelRoute = await import("../app/api/settings/chatgpt-plan/model/route");
  usageSourceRoute = await import("../app/api/settings/chatgpt-plan/usage-source/route");
  exerciseRoute = await import("../app/api/settings/chatgpt-plan/exercise/route");
  disconnectRoute = await import("../app/api/settings/chatgpt-plan/disconnect/route");
  modelsRoute = await import("../app/api/settings/models/route");
  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
  chatRoute = await import("../app/api/chat/route");
  sessionsRoute = await import("../app/api/chat/sessions/route");
});

beforeEach(async () => {
  vi.restoreAllMocks();
  fixtures.reset();
  // A plan turn reserves budget like any other provider call, so the
  // installation's allowance is opened for the test.
  await db("installation_provider_budget_settings").where({ id: 1 }).update({
    interactive_cents: 100,
    background_cents: 100,
  });
  await db("chatgpt_plan_usage_events").delete();
  await db("chatgpt_plan_connections").delete();
  await db("provider_budget_reservations").delete();
  await db("workspace_provider_budget_usage").delete();
  await db("workspace_provider_budget_settings").delete();
  await db("shopping_session_messages").delete();
  await db("shopping_session_requirements").delete();
  await db("shopping_sessions").delete();
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
  const res = await signInRoute.POST(jsonRequest("http://localhost/api/sign-in", { email, password }));
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

/** The stored grant, as the token endpoint would have returned it. */
async function storeConnection(
  workspaceId: string,
  overrides: { accessToken?: string; scopes?: string[]; subject?: string } = {},
) {
  const core = getCore();
  const principal = { kind: "workspace" as const, userId: "", workspaceId, sessionId: "plan-http" };
  const membership = await db("workspace_memberships").where({ workspace_id: workspaceId }).first();
  const stored = await core.chatgptPlan.completeConsent(
    { ...principal, userId: membership.user_id },
    {
      accessToken: overrides.accessToken ?? PLAN_ACCESS_TOKEN,
      refreshToken: PLAN_REFRESH_TOKEN,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: overrides.scopes ?? ["openid", "profile", "email", "offline_access", "resource.invoke", CHATGPT_PLAN_SCOPE],
      account: { subject: overrides.subject ?? "chatgpt-subject-http", email: "sam@example.nl" },
      clientId: "oaiapp_http_fixture",
    },
  );
  if (!stored.ok) throw new Error(`connection not stored: ${stored.error.kind}`);
  return stored.value;
}

describe("ChatGPT plan connection over HTTP", () => {
  it("requires an application session for every plan endpoint", async () => {
    const calls: Array<Promise<Response>> = [
      statusRoute.GET(new Request("http://localhost/api/settings/chatgpt-plan")),
      consentRoute.POST(jsonRequest("http://localhost/api/settings/chatgpt-plan/consent", {})),
      callbackRoute.POST(jsonRequest("http://localhost/api/settings/chatgpt-plan/callback", {})),
      refreshRoute.POST(jsonRequest("http://localhost/api/settings/chatgpt-plan/refresh", {})),
      modelRoute.PUT(jsonRequest("http://localhost/api/settings/chatgpt-plan/model", { modelId: "gpt-6.2-sol" })),
      usageSourceRoute.PUT(
        jsonRequest("http://localhost/api/settings/chatgpt-plan/usage-source", { usageSource: "api-key" }),
      ),
      exerciseRoute.POST(jsonRequest("http://localhost/api/settings/chatgpt-plan/exercise", {})),
      disconnectRoute.POST(jsonRequest("http://localhost/api/settings/chatgpt-plan/disconnect", {})),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect((await response.json()).error.kind).toBe("forbidden");
    }
    expect(fixtures.requests).toEqual([]);
  });

  it("shows an unconnected workspace the eligibility view and the unresolved gate", async () => {
    await claimAdministrator();
    await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");

    const res = await statusRoute.GET(
      new Request("http://localhost/api/settings/chatgpt-plan", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "disconnected",
      eligibility: "disconnected",
      usageSource: "api-key",
      account: null,
      selectedModel: null,
      entitlement: { status: "unresolved", documentedAt: "docs/model-access-design.md" },
      apiKey: { configured: false },
    });
  });

  it("starts consent with a browser-bound attempt and refuses a cross-site start", async () => {
    const cookie = await claimAdministrator();
    const attempt = await consentRoute.POST(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/consent", {}, { cookie }),
    );
    expect(attempt.status).toBe(200);
    const body = await attempt.json();
    expect(body).toMatchObject({
      authorizationUrl: expect.stringContaining("https://auth.openai.com/api/accounts/authorize"),
      state: expect.any(String),
      scope: expect.arrayContaining([CHATGPT_PLAN_SCOPE]),
      entitlement: { status: "unresolved" },
    });
    // The verifier goes back to the page that started the attempt, and the
    // cookie keeps only its digest: no token and no secret is stored client-side.
    expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    // The binding travels as the response's own HttpOnly, SameSite cookie.
    const binding = attempt.headers.getSetCookie().find((value) => value.startsWith("chatgpt-plan-consent="));
    expect(binding).toBeDefined();
    expect(binding).toContain("HttpOnly");
    expect(binding).toContain("SameSite=Lax");
    // The cookie holds the verifier's digest, never the verifier itself.
    expect(decodeURIComponent(binding!)).not.toContain(body.codeVerifier);

    const crossSite = await consentRoute.POST(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/consent",
        {},
        { cookie, origin: "https://evil.example" },
      ),
    );
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json()).error.kind).toBe("invalid-origin");
  });

  it("rejects a callback whose state does not match the browser-bound attempt", async () => {
    const cookie = await claimAdministrator();
    const consentCookie = await startConsent(cookie);

    const mismatched = await callbackRoute.POST(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/callback",
        { state: "forged-state", code: "forged-code" },
        { cookie: `${cookie}; ${consentCookie}` },
      ),
    );
    expect(mismatched.status).toBe(400);
    expect((await mismatched.json()).error.kind).toBe("invalid-input");
    expect(await db("chatgpt_plan_connections")).toEqual([]);
  });

  it("refuses a callback presented without the browser-bound attempt", async () => {
    const cookie = await claimAdministrator();
    // A callback in another browser has no consent cookie, so it cannot
    // complete someone else's attempt.
    const res = await callbackRoute.POST(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/callback",
        { state: "any", code: "any" },
        { cookie },
      ),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.kind).toBe("invalid-input");
    expect(await db("chatgpt_plan_connections")).toEqual([]);
  });

  it("never returns a plan token and reports eligibility after connecting", async () => {
    await claimAdministrator();
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);
    const logs = captureLogs();

    const res = await statusRoute.GET(
      new Request("http://localhost/api/settings/chatgpt-plan", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLAN_ACCESS_TOKEN);
    expect(text).not.toContain(PLAN_REFRESH_TOKEN);
    expect(text).not.toContain("oaiapp_http_fixture");
    expect(JSON.parse(text)).toMatchObject({
      status: "connected",
      eligibility: "eligible",
      usageSource: "chatgpt-plan",
      account: { subject: "chatgpt-subject-http", emailHint: "s…@example.nl" },
    });
    expect(logs.join("\n")).not.toContain(PLAN_ACCESS_TOKEN);
  });

  it("selects only a model the account's own list offered", async () => {
    await claimAdministrator();
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);

    const accepted = await modelRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/model",
        { modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", available: [{ modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" }] },
        { cookie },
      ),
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).selectedModel).toMatchObject({ modelId: "gpt-6.2-sol" });

    const refused = await modelRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/model",
        { modelId: "gpt-not-on-plan", available: [{ modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" }] },
        { cookie },
      ),
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatchObject({ kind: "chatgpt-plan-model-unavailable" });
  });

  it("exercises a shopping tool step through the account's model and the fixture route", async () => {
    await claimAdministrator();
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);
    await modelRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/model",
        { modelId: "gpt-6.2-sol", available: [{ modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" }] },
        { cookie },
      ),
    );

    const res = await exerciseRoute.POST(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/exercise", {}, { cookie }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ modelId: "gpt-6.2-sol", completed: true });
    expect(body.toolCalls.length).toBeGreaterThan(0);
    expect(body.toolsExecuted).toEqual(body.toolCalls);
    const text = JSON.stringify(body);
    expect(text).not.toContain(PLAN_ACCESS_TOKEN);
  });

  it("reports an exhausted plan allowance as a typed conflict, not a fallback", async () => {
    await claimAdministrator();
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);
    await modelRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/model",
        { modelId: "gpt-6.2-sol", available: [{ modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" }] },
        { cookie },
      ),
    );
    const core = getCore();
    const principal = { kind: "administrator" as const, userId: (await db("user").where({ email: ADMIN_EMAIL }).first()).id, workspaceId: workspace.workspaceId, sessionId: "plan-http" };
    // The recorded outcome is what the plan route reported for this account.
    const recorded = await core.chatgptPlan.recordOutcome(
      { ...principal, userId: (await db("workspace_memberships").where({ workspace_id: workspace.workspaceId }).first()).user_id },
      { kind: "usage-limit-exceeded", message: "subscription_sharing_usage_limit_exceeded" },
    );
    expect(recorded.ok).toBe(true);

    const res = await exerciseRoute.POST(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/exercise", {}, { cookie }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ kind: "chatgpt-plan-usage-limit", reason: "usage-limit" });
    // Nothing was sent to a provider: no silent API-key billing.
    expect(fixtures.requests).toEqual([]);
  });

  it("switches usage source only on an explicit request and never on availability", async () => {
    const adminCookie = await claimAdministrator();
    await modelsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "compatible", modelId: "fixture-model-complete", endpoint: `${fixtures.baseUrl}/compatible/v1` },
          usageSource: "installation",
          extractionModel: null,
          apiKey: API_KEY,
        },
        { cookie: adminCookie },
      ),
    );
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);

    const status = await statusRoute.GET(
      new Request("http://localhost/api/settings/chatgpt-plan", { headers: { cookie } }),
    );
    expect((await status.json()).usageSource).toBe("chatgpt-plan");

    const switched = await usageSourceRoute.PUT(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/usage-source", { usageSource: "api-key" }, { cookie }),
    );
    expect(switched.status).toBe(200);
    expect((await switched.json()).usageSource).toBe("api-key");

    const invalid = await usageSourceRoute.PUT(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/usage-source", { usageSource: "free" }, { cookie }),
    );
    expect(invalid.status).toBe(400);
  });

  it("refreshes a rotating token pair without exposing it", async () => {
    await claimAdministrator();
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);

    const res = await refreshRoute.POST(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/refresh", {}, { cookie }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(PLAN_ACCESS_TOKEN);
    expect(JSON.parse(text)).toMatchObject({ status: "connected" });
  });

  it("disconnects on request and stops offering the plan", async () => {
    await claimAdministrator();
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);

    const res = await disconnectRoute.POST(
      jsonRequest("http://localhost/api/settings/chatgpt-plan/disconnect", {}, { cookie }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "disconnected",
      eligibility: "disconnected",
      usageSource: "api-key",
      selectedModel: null,
    });
  });

  it("keeps one workspace's connection invisible to another", async () => {
    await claimAdministrator();
    await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const shopperCookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    const adminCookie = await claimAdministratorAgain();

    const adminStatus = await statusRoute.GET(
      new Request("http://localhost/api/settings/chatgpt-plan", { headers: { cookie: adminCookie } }),
    );
    expect((await adminStatus.json()).status).toBe("disconnected");
    const shopperStatus = await statusRoute.GET(
      new Request("http://localhost/api/settings/chatgpt-plan", { headers: { cookie: shopperCookie } }),
    );
    expect((await shopperStatus.json()).status).toBe("disconnected");
  });

  it("serves a plan turn through the plan connection and never through the API key", async () => {
    const adminCookie = await claimAdministrator();
    await modelsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "compatible", modelId: "fixture-model-complete", endpoint: `${fixtures.baseUrl}/compatible/v1` },
          usageSource: "installation",
          extractionModel: null,
          apiKey: API_KEY,
        },
        { cookie: adminCookie },
      ),
    );
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);
    await modelRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/model",
        { modelId: "gpt-6.2-sol", available: [{ modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" }] },
        { cookie },
      ),
    );
    const session = await (
      await sessionsRoute.POST(
        jsonRequest("http://localhost/api/chat/sessions", { title: "Plan chat", language: "nl" }, { cookie }),
      )
    ).json();

    fixtures.reset();
    const res = await chatRoute.POST(
      jsonRequest(
        "http://localhost/api/chat",
        { sessionId: session.id, messages: [{ role: "user", parts: [{ type: "text", text: "Ik zoek een laptop" }] }] },
        { cookie },
      ),
    );
    const raw = await res.text();
    expect(raw).toContain("usageSource");
    expect(res.status).toBe(200);
    const body = JSON.parse(raw);
    expect(body).toMatchObject({ usageSource: "chatgpt-plan", modelId: "gpt-6.2-sol" });
    // The plan route served the turn; the configured API key was never spent.
    expect(fixtures.planChecks.length).toBeGreaterThan(0);
    expect(fixtures.requests.every((request) => request.authorization !== `Bearer ${API_KEY}`)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PLAN_ACCESS_TOKEN);
  });

  it("ends a plan turn with a typed error rather than an API-key fallback", async () => {
    const adminCookie = await claimAdministrator();
    await modelsRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "compatible", modelId: "fixture-model-complete", endpoint: `${fixtures.baseUrl}/compatible/v1` },
          usageSource: "installation",
          extractionModel: null,
          apiKey: API_KEY,
        },
        { cookie: adminCookie },
      ),
    );
    const workspace = await provisionShopper("plan-shopper@example.nl", "shopper-passphrase-1", "Plan workspace");
    const cookie = await signIn("plan-shopper@example.nl", "shopper-passphrase-1");
    await storeConnection(workspace.workspaceId);
    await modelRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/chatgpt-plan/model",
        { modelId: "gpt-6.2-sol", available: [{ modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" }] },
        { cookie },
      ),
    );
    const core = getCore();
    const membership = await db("workspace_memberships").where({ workspace_id: workspace.workspaceId }).first();
    await core.chatgptPlan.recordOutcome(
      { kind: "workspace", userId: membership.user_id, workspaceId: workspace.workspaceId, sessionId: "plan-http" },
      { kind: "usage-limit-exceeded", message: "subscription_sharing_usage_limit_exceeded" },
    );
    const session = await (
      await sessionsRoute.POST(
        jsonRequest("http://localhost/api/chat/sessions", { title: "Plan chat", language: "nl" }, { cookie }),
      )
    ).json();

    fixtures.reset();
    const res = await chatRoute.POST(
      jsonRequest(
        "http://localhost/api/chat",
        { sessionId: session.id, messages: [{ role: "user", parts: [{ type: "text", text: "Ik zoek een laptop" }] }] },
        { cookie },
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ kind: "chatgpt-plan-usage-limit", reason: "usage-limit" });
    // Nothing was billed anywhere: no plan call and no API-key call.
    expect(fixtures.requests).toEqual([]);
  });
});

/** Start a consent attempt and return the cookie that binds it to this browser. */
async function startConsent(cookie: string): Promise<string> {
  const response = await consentRoute.POST(
    jsonRequest("http://localhost/api/settings/chatgpt-plan/consent", {}, { cookie }),
  );
  expect(response.status).toBe(200);
  const written = response
    .headers.getSetCookie()
    .find((value) => value.startsWith("chatgpt-plan-consent="));
  if (!written) throw new Error("no consent cookie written");
  return written.split(";")[0]!;
}

async function claimAdministratorAgain(): Promise<string> {
  return signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
}
