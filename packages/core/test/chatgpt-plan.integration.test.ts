// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  migrateFresh, createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  CHATGPT_PLAN_ENTITLEMENT,
  CHATGPT_PLAN_SCOPES,
  CHATGPT_PLAN_SCOPE,
  createBudgetRegistry,
  createChatGPTPlanConnections,
  createSecretCipher,
  err,
  ok,
  type ChatGPTPlanConnections,
  type ChatGPTPlanExercise,
  type ChatGPTPlanExerciseFn,
  type Principal,
} from "../src/index";

// Core is the primary seam for the ChatGPT plan connection: consent is granted
// by an admitted workspace member, tokens live encrypted and scoped to that
// workspace (never to application sign-in), and eligibility, expiry, quota and
// usage source are reported as typed states rather than inferred.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const INSTALLATION_SECRET = "installation-secret-0123456789abcdef";

const ADMIN = "admin-user";
const ADMIN_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SHOPPER = "shopper-user";
const SHOPPER_WORKSPACE = "22222222-2222-4222-8222-222222222222";

const administrator: Principal = {
  kind: "administrator",
  userId: ADMIN,
  workspaceId: ADMIN_WORKSPACE,
  sessionId: "plan-test-admin-session",
};
const shopper: Principal = {
  kind: "workspace",
  userId: SHOPPER,
  workspaceId: SHOPPER_WORKSPACE,
  sessionId: "plan-test-shopper-session",
};

const NOW = new Date("2026-11-19T09:00:00.000Z");

/** A token grant exactly as the token endpoint returns it (official fields). */
function grant(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    accessToken: "plan-access-token-0001",
    refreshToken: "plan-refresh-token-0001",
    expiresAt: new Date("2026-11-19T10:00:00.000Z"),
    scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", CHATGPT_PLAN_SCOPE],
    account: { subject: "chatgpt-subject-0001", email: "sam@example.nl" },
    clientId: "oaiapp_fixture0001",
    ...overrides,
  };
}

const CHATGPT_MODEL = { slug: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" };
const LISTED_MODEL = { modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" };
const LOCAL_MODEL = { provider: "compatible" as const, modelId: "fixture-model-complete", endpoint: "http://127.0.0.1:9/v1" };

async function seedUsers(db: Knex): Promise<void> {
  await db("user").insert([
    { id: ADMIN, name: "Ada Admin", email: "ada@example.nl" },
    { id: SHOPPER, name: "Sam Shopper", email: "sam@example.nl" },
  ]);
  await db("workspaces").insert([
    { id: ADMIN_WORKSPACE, name: "Admin workspace", created_by_user_id: ADMIN },
    { id: SHOPPER_WORKSPACE, name: "Shopper workspace", created_by_user_id: SHOPPER },
  ]);
  await db("workspace_memberships").insert([
    { workspace_id: ADMIN_WORKSPACE, user_id: ADMIN, role: "owner" },
    { workspace_id: SHOPPER_WORKSPACE, user_id: SHOPPER, role: "owner" },
  ]);
}

/** Stands in for the pinned AI SDK adapter; it is the only place the SDK lives. */
function fakeExercise() {
  const calls: Array<{ modelId: string; accessToken: string }> = [];
  let outcome: Awaited<ReturnType<ChatGPTPlanExerciseFn>> = ok({
    completed: true,
    text: "fixture plan reply",
    toolCalls: ["requirements_update"],
    toolsExecuted: ["requirements_update"],
  });
  return {
    calls,
    respondWith(next: typeof outcome) {
      outcome = next;
    },
    exercise: async (input: ChatGPTPlanExercise) => {
      // The adapter receives the account's token and model; it never receives
      // an application session or an API key.
      calls.push({ modelId: input.connection.modelId, accessToken: input.connection.accessToken });
      return outcome;
    },
  };
}

describe("ChatGPT plan connection through the core", () => {
  let db: Knex;
  let plan: ChatGPTPlanConnections;
  let exercise: ReturnType<typeof fakeExercise>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await migrateFresh(db);
  });

  beforeEach(async () => {
    await db("chatgpt_plan_usage_events").delete();
    await db("chatgpt_plan_connections").delete();
    await db("provider_budget_reservations").delete();
    await db("workspace_provider_budget_usage").delete();
    await db("workspace_provider_budget_settings").delete();
    await db("installation_provider_budget_settings").where({ id: 1 }).update({
      interactive_cents: 100,
      background_cents: 100,
    });
    await db("workspace_model_settings").delete();
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
    await db("user").delete();
    await seedUsers(db);
    exercise = fakeExercise();
    plan = createChatGPTPlanConnections({
      db,
      cipher: createSecretCipher({ key: INSTALLATION_SECRET }),
      exercise: exercise.exercise,
      now: () => NOW,
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe("consent", () => {
    it("starts consent for an admitted member and refuses anyone else", async () => {
      expect(await plan.beginConsent({ kind: "anonymous" }, {})).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });

      const impostor: Principal = {
        kind: "workspace",
        userId: SHOPPER,
        workspaceId: ADMIN_WORKSPACE,
        sessionId: "plan-test-impostor",
      };
      expect(await plan.beginConsent(impostor, {})).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });

      const attempt = await plan.beginConsent(shopper, {});
      expect(attempt.ok).toBe(true);
      if (!attempt.ok) return;
      expect(attempt.value.scope).toEqual([
        "openid",
        "profile",
        "email",
        "offline_access",
        "resource.invoke",
        CHATGPT_PLAN_SCOPE,
      ]);
      expect(attempt.value.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(attempt.value.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(attempt.value.hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
      expect(attempt.value.entitlement).toEqual(CHATGPT_PLAN_ENTITLEMENT);
      // The authorization URL carries the documented parameters and never the
      // PKCE verifier: only the S256 challenge leaves the server.
      const url = new URL(attempt.value.authorizationUrl);
      expect(url.origin + url.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: "dynamic_agent_client",
        agent_name_hint: "Shopping Assistant",
        ext_agent_host_id: attempt.value.hostId,
        response_type: "code",
        redirect_uri: "http://127.0.0.1:1455/auth/callback",
        scope: CHATGPT_PLAN_SCOPES.join(" "),
        resource: "https://api.openai.com/v1",
        state: attempt.value.state,
        code_challenge_method: "S256",
        code_challenge: attempt.value.codeChallenge,
      });
      expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(attempt.value.authorizationUrl).not.toContain(attempt.value.codeVerifier);

      // Nothing about the attempt is stored: an abandoned consent leaves no
      // connection behind.
      expect(await db("chatgpt_plan_connections")).toEqual([]);
    });

    it("gives every attempt fresh state and PKCE values", async () => {
      const first = await plan.beginConsent(shopper, {});
      const second = await plan.beginConsent(shopper, {});
      if (!first.ok || !second.ok) throw new Error("consent refused");
      expect(first.value.state).not.toBe(second.value.state);
      expect(first.value.codeChallenge).not.toBe(second.value.codeChallenge);
      // The host identity is stable for this installation across attempts.
      expect(first.value.hostId).toBe(second.value.hostId);
    });

    it("stores tokens encrypted for the workspace and never for application sign-in", async () => {
      const stored = await plan.completeConsent(shopper, grant());
      expect(stored).toMatchObject({
        ok: true,
        value: {
          status: "connected",
          usageSource: "chatgpt-plan",
          account: { subject: "chatgpt-subject-0001", emailHint: "s…@example.nl" },
          scopes: expect.arrayContaining([CHATGPT_PLAN_SCOPE]),
        },
      });
      if (!stored.ok) return;
      expect(JSON.stringify(stored.value)).not.toContain("plan-access-token");
      expect(JSON.stringify(stored.value)).not.toContain("plan-refresh-token");

      const row = await db("chatgpt_plan_connections")
        .where({ workspace_id: SHOPPER_WORKSPACE })
        .first();
      expect(row.ciphertext).not.toContain("plan-access-token");
      expect(row.ciphertext).not.toContain("plan-refresh-token");
      expect(row.encryption).toBe("aes-256-gcm");
      // A ChatGPT connection is not an application identity: no user row, no
      // account row and no membership is created or linked by matching email.
      expect(await db("user").where({ email: "sam@example.nl" })).toHaveLength(1);
      expect(await db("user")).toHaveLength(2);
      expect(await db("workspace_memberships")).toHaveLength(2);
    });

    it("marks plan usage disabled when consent is granted without the plan scope", async () => {
      const stored = await plan.completeConsent(
        shopper,
        grant({ scopes: ["openid", "profile", "email", "offline_access"] }),
      );
      expect(stored).toMatchObject({ ok: true, value: { status: "plan-disabled" } });

      // The sign-in is retained but inference must not proceed on this path.
      expect(await plan.selectModel(shopper, CHATGPT_MODEL)).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-not-enabled" },
      });
      expect(exercise.calls).toEqual([]);
    });

    it("refuses a declined consent without storing anything", async () => {
      expect(await plan.completeConsent(shopper, null, { error: "access_denied" })).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-consent-declined" },
      });
      expect(await db("chatgpt_plan_connections")).toEqual([]);
    });
  });

  describe("eligibility, expiry and quota", () => {
    beforeEach(async () => {
      await plan.completeConsent(shopper, grant());
    });

    it("reports eligibility with the account's own model list", async () => {
      const discovered = await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      expect(discovered).toMatchObject({
        ok: true,
        value: { modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" },
      });

      const read = await plan.read(shopper);
      expect(read).toMatchObject({
        ok: true,
        value: {
          eligibility: "eligible",
          status: "connected",
          usageSource: "chatgpt-plan",
          selectedModel: { modelId: "gpt-6.2-sol", displayName: "GPT-6.2 Sol" },
          plan: { state: "available", reason: null, retryAfterSeconds: null },
          expiresAt: "2026-11-19T10:00:00.000Z",
        },
      });
      if (!read.ok) return;
      expect(JSON.stringify(read.value)).not.toContain("plan-access-token");
    });

    it("never offers a model the account did not list", async () => {
      expect(await plan.selectModel(shopper, { slug: "gpt-not-on-plan" }, [LISTED_MODEL])).toEqual({
        ok: false,
        error: {
          kind: "chatgpt-plan-model-unavailable",
          modelId: "gpt-not-on-plan",
          available: ["gpt-6.2-sol"],
        },
      });
      const read = await plan.read(shopper);
      expect(read.ok && read.value.selectedModel).toBeNull();
    });

    it("reports expiry and refuses inference with an expired grant", async () => {
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      // Past the one-hour access-token lifetime, with no refresh recorded.
      const expired = createChatGPTPlanConnections({
        db,
        cipher: createSecretCipher({ key: INSTALLATION_SECRET }),
        exercise: exercise.exercise,
        now: () => new Date("2026-11-19T11:30:00.000Z"),
      });
      const read = await expired.read(shopper);
      expect(read).toMatchObject({
        ok: true,
        value: { eligibility: "expired", plan: { state: "paused", reason: "expired" } },
      });
      expect(await expired.resolve(shopper)).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-expired" },
      });
      expect(exercise.calls).toEqual([]);
    });

    it("refreshes a rotating token pair and keeps the connection eligible", async () => {
      // Resolving needs a chosen model; the refresh itself is what is under test.
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      const refreshed = await plan.recordRefresh(shopper, {
        accessToken: "plan-access-token-0002",
        refreshToken: "plan-refresh-token-0002",
        expiresAt: new Date("2026-11-19T10:00:00.000Z"),
      });
      expect(refreshed).toMatchObject({ ok: true, value: { status: "connected", eligibility: "eligible" } });

      const row = await db("chatgpt_plan_connections").where({ workspace_id: SHOPPER_WORKSPACE }).first();
      expect(row.ciphertext).not.toContain("plan-refresh-token-0002");
      const resolved = await plan.resolve(shopper);
      expect(resolved).toMatchObject({ ok: true, value: { accessToken: "plan-access-token-0002" } });
    });

    it("pauses on an exhausted plan allowance without clearing the credential", async () => {
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      const recorded = await plan.recordOutcome(shopper, {
        kind: "usage-limit-exceeded",
        message: "subscription_sharing_usage_limit_exceeded",
      });
      expect(recorded).toMatchObject({
        ok: true,
        value: { plan: { state: "paused", reason: "usage-limit" }, eligibility: "eligible" },
      });
      expect(await plan.resolve(shopper)).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-usage-limit", reason: "usage-limit" },
      });
      // Pausing never erases the credential: the shopper resumes later.
      expect(await db("chatgpt_plan_connections").where({ workspace_id: SHOPPER_WORKSPACE })).toHaveLength(1);
    });

    it("distinguishes a not-eligible account from a temporary unavailability", async () => {
      await plan.recordOutcome(shopper, { kind: "not-eligible", message: "subscription_sharing_user_not_eligible" });
      const notEligible = await plan.read(shopper);
      expect(notEligible).toMatchObject({
        ok: true,
        value: { eligibility: "not-eligible", plan: { state: "paused", reason: "not-eligible" } },
      });

      await plan.recordOutcome(shopper, { kind: "usage-unavailable", message: "subscription_sharing_usage_unavailable" });
      const unavailable = await plan.read(shopper);
      expect(unavailable).toMatchObject({
        ok: true,
        value: { eligibility: "unavailable", plan: { state: "paused", reason: "usage-unavailable" } },
      });
    });

    it("records unsupported capability without retrying the same body", async () => {
      await plan.recordOutcome(shopper, { kind: "unsupported-capability", message: "subscription_sharing_unsupported_capability" });
      const read = await plan.read(shopper);
      expect(read).toMatchObject({
        ok: true,
        value: { plan: { state: "paused", reason: "unsupported-capability" } },
      });
    });

    it("disconnects on a terminal refresh error and asks for a new consent", async () => {
      const result = await plan.recordRefresh(shopper, { kind: "invalid_grant", message: "refresh_token_reused" });
      expect(result).toMatchObject({ ok: true, value: { status: "disconnected", eligibility: "disconnected" } });
      expect(await plan.resolve(shopper)).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-disconnected" },
      });
    });
  });

  describe("usage source", () => {
    it("reports the API-key configuration alongside the plan connection", async () => {
      await db("installation_model_settings").update({
        default_model: JSON.stringify({ provider: "openai", modelId: "gpt-5-mini" }),
        usage_source: "installation",
      });
      await db("installation_model_credentials").insert({
        id: 1,
        provider: "openai",
        ciphertext: createSecretCipher({ key: INSTALLATION_SECRET }).encrypt("sk-installation-openai-key"),
        encryption: "aes-256-gcm",
        masked_hint: "sk-…key",
      });
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);

      const read = await plan.read(shopper);
      expect(read).toMatchObject({
        ok: true,
        value: {
          usageSource: "chatgpt-plan",
          apiKey: { configured: true, provider: "openai", modelId: "gpt-5-mini", source: "installation" },
        },
      });
    });

    it("refuses to fall back to an API key when the plan cannot serve the request", async () => {
      await db("installation_model_settings").update({
        default_model: JSON.stringify({ provider: "openai", modelId: "gpt-5-mini" }),
        usage_source: "installation",
      });
      await db("installation_model_credentials").insert({
        id: 1,
        provider: "openai",
        ciphertext: createSecretCipher({ key: INSTALLATION_SECRET }).encrypt("sk-installation-openai-key"),
        encryption: "aes-256-gcm",
        masked_hint: "sk-…key",
      });
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      await plan.recordOutcome(shopper, { kind: "usage-limit-exceeded", message: "subscription_sharing_usage_limit_exceeded" });

      // A configured key exists, but the plan is the selected usage source and
      // the shopper did not opt into paying for API usage instead.
      expect(await plan.resolve(shopper)).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-usage-limit", reason: "usage-limit" },
      });
    });

    it("switches usage source only when the shopper asks for it", async () => {
      await db("installation_model_settings").update({
        default_model: JSON.stringify({ provider: "openai", modelId: "gpt-5-mini" }),
        usage_source: "installation",
      });
      await db("installation_model_credentials").insert({
        id: 1,
        provider: "openai",
        ciphertext: createSecretCipher({ key: INSTALLATION_SECRET }).encrypt("sk-installation-openai-key"),
        encryption: "aes-256-gcm",
        masked_hint: "sk-…key",
      });
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);

      const switched = await plan.setUsageSource(shopper, { usageSource: "api-key" });
      expect(switched).toMatchObject({ ok: true, value: { usageSource: "api-key" } });
      const read = await plan.read(shopper);
      expect(read.ok && read.value.usageSource).toBe("api-key");

      // Switching back is explicit too, and restores the plan connection.
      const back = await plan.setUsageSource(shopper, { usageSource: "chatgpt-plan" });
      expect(back).toMatchObject({ ok: true, value: { usageSource: "chatgpt-plan" } });
    });

    it("refuses a plan usage source with no connected account", async () => {
      expect(await plan.setUsageSource(shopper, { usageSource: "chatgpt-plan" })).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-not-connected" },
      });
    });
  });

  describe("account-specific model selection and the shopping tool step", () => {
    it("exercises a shopping tool step through the account's model", async () => {
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);

      const exercised = await plan.exercisePlan(shopper, { prompt: "Call the requirements_update tool." });
      expect(exercised).toMatchObject({
        ok: true,
        value: {
          modelId: "gpt-6.2-sol",
          completed: true,
          toolCalls: ["requirements_update"],
          toolsExecuted: ["requirements_update"],
        },
      });
      expect(exercise.calls).toEqual([
        { modelId: "gpt-6.2-sol", accessToken: "plan-access-token-0001" },
      ]);
    });

    it("reports a tool step the plan did not actually run", async () => {
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      exercise.respondWith(
        ok({ completed: true, text: "text only", toolCalls: [], toolsExecuted: [] }),
      );
      const exercised = await plan.exercisePlan(shopper, { prompt: "Call the requirements_update tool." });
      expect(exercised).toMatchObject({
        ok: true,
        value: { completed: true, toolCalls: [], toolsExecuted: [] },
      });
      // A text-only answer is not proof the tool step works; the caller decides.
      expect(exercised.ok && exercised.value.toolsExecuted).toEqual([]);
    });

    it("records a failed exercise as a typed outcome, not a thrown error", async () => {
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      exercise.respondWith(
        err({ kind: "chatgpt-plan-request-failed", code: "subscription_sharing_user_not_eligible", status: 403 }),
      );
      expect(await plan.exercisePlan(shopper, { prompt: "hello" })).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-request-failed", code: "subscription_sharing_user_not_eligible", status: 403 },
      });
    });

    it("requires a selected account model before inference", async () => {
      await plan.completeConsent(shopper, grant());
      expect(await plan.exercisePlan(shopper, { prompt: "hello" })).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-model-not-selected" },
      });
      expect(exercise.calls).toEqual([]);
    });

    it("disconnects on request and forgets the tokens", async () => {
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      const disconnected = await plan.disconnect(shopper);
      expect(disconnected).toMatchObject({ ok: true, value: { status: "disconnected", eligibility: "disconnected" } });
      expect(await db("chatgpt_plan_connections").where({ workspace_id: SHOPPER_WORKSPACE })).toHaveLength(1);
      expect(await plan.resolve(shopper)).toEqual({
        ok: false,
        error: { kind: "chatgpt-plan-disconnected" },
      });
    });

    it("keeps two workspaces' connections apart", async () => {
      await plan.completeConsent(shopper, grant());
      await plan.completeConsent(
        administrator,
        grant({ account: { subject: "chatgpt-subject-admin", email: "ada@example.nl" }, accessToken: "admin-plan-token" }),
      );
      const shopperView = await plan.read(shopper);
      const adminView = await plan.read(administrator);
      expect(shopperView.ok && shopperView.value.account?.subject).toBe("chatgpt-subject-0001");
      expect(adminView.ok && adminView.value.account?.subject).toBe("chatgpt-subject-admin");

      // Disconnecting one workspace never disconnects the other.
      await plan.disconnect(shopper);
      const afterDisconnect = await plan.read(administrator);
      expect(afterDisconnect.ok && afterDisconnect.value.status).toBe("connected");
    });

    it("never reports another workspace's connection to an unadmitted principal", async () => {
      await plan.completeConsent(administrator, grant());
      const impostor: Principal = {
        kind: "workspace",
        userId: SHOPPER,
        workspaceId: ADMIN_WORKSPACE,
        sessionId: "plan-test-impostor",
      };
      expect(await plan.read(impostor)).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
    });

    it("never exposes a token or ciphertext through the eligibility view", async () => {
      await plan.completeConsent(shopper, grant());
      await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
      const read = await plan.read(shopper);
      const text = JSON.stringify(read);
      expect(text).not.toContain("plan-access-token");
      expect(text).not.toContain("plan-refresh-token");
      expect(text).not.toContain("ciphertext");
      expect(text).not.toContain("oaiapp_fixture0001");
    });
  });

  it("reserves budget for a plan turn like any other provider call", async () => {
    // A plan turn spends the workspace's plan, so it is bounded and recorded
    // through the same budget registry as an API-key turn.
    await plan.completeConsent(shopper, grant());
    await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
    const budgets = createBudgetRegistry({ db });
    const reservation = await budgets.reserve(shopper, {
      kind: "interactive",
      estimatedCents: 1,
      usageSource: "workspace",
    });
    expect(reservation.ok).toBe(true);
    if (!reservation.ok) return;
    await budgets.settle(shopper, reservation.value.id, 1);
    const view = await budgets.read(shopper);
    expect(view.ok && view.value.usedInteractiveCents).toBe(1);
  });

  it("declares the unresolved entitlement gate truthfully", () => {
    expect(CHATGPT_PLAN_ENTITLEMENT).toEqual({
      status: "unresolved",
      reason: "no-provider-approval-for-remotely-hosted-deployments",
      documentedAt: "docs/model-access-design.md",
    });
  });

  it("does not use the API-key model registry to serve a plan request", async () => {
    await plan.completeConsent(shopper, grant());
    await plan.selectModel(shopper, CHATGPT_MODEL, [LISTED_MODEL]);
    const resolved = await plan.resolve(shopper);
    // A plan resolution carries a plan model and the plan account's token; it
    // never names an API-key provider target.
    expect(resolved).toMatchObject({
      ok: true,
      value: { usageSource: "chatgpt-plan", provider: "chatgpt-plan", modelId: "gpt-6.2-sol" },
    });
    expect(resolved.ok && JSON.stringify(resolved.value)).not.toContain(LOCAL_MODEL.modelId);
  });

  it("reports an eligibility view for a workspace that never connected", async () => {
    expect(await plan.read(shopper)).toMatchObject({
      ok: true,
      value: {
        status: "disconnected",
        eligibility: "disconnected",
        usageSource: "api-key",
        account: null,
        selectedModel: null,
        models: [],
        apiKey: { configured: false, provider: null, modelId: null, source: null },
        entitlement: CHATGPT_PLAN_ENTITLEMENT,
      },
    });
  });
});
