// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createBudgets, createModelRegistry, createSecretCipher, err } from "@shopping/core";
import type { Budgets, ModelRegistry, Principal, ResolvedModel } from "@shopping/core";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { startProviderFixtures, type ProviderFixture } from "./support/provider-fixtures";

// The budget is enforced against the real AI SDK adapter and the loopback
// provider fixtures: when the allowance is spent, zero HTTP requests reach the
// provider, and nothing quietly switches to another provider, model or key.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const INSTALLATION_SECRET = "installation-secret-0123456789abcdef";
const INSTALLATION_KEY = "sk-budget-installation-key-0001";
const WORKSPACE_KEY = "fixture-budget-workspace-key-0001";

const ADMIN = "budget-adapter-admin";
const ADMIN_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SHOPPER = "budget-adapter-shopper";
const SHOPPER_WORKSPACE = "22222222-2222-4222-8222-222222222222";

const administrator: Principal = {
  kind: "administrator",
  userId: ADMIN,
  workspaceId: ADMIN_WORKSPACE,
  sessionId: "budget-adapter-admin-session",
};
const shopper: Principal = {
  kind: "workspace",
  userId: SHOPPER,
  workspaceId: SHOPPER_WORKSPACE,
  sessionId: "budget-adapter-shopper-session",
};

/** One real model call through the pinned SDK adapter for a resolved model. */
async function callProvider(model: ResolvedModel, prompt: string): Promise<string> {
  const target = model;
  const languageModel = (() => {
    switch (target.provider) {
      case "openai":
        return createOpenAI({
          apiKey: target.apiKey,
          ...(target.endpoint ? { baseURL: target.endpoint } : {}),
        })(target.modelId);
      case "anthropic":
        return createAnthropic({
          apiKey: target.apiKey,
          ...(target.endpoint ? { baseURL: target.endpoint } : {}),
        })(target.modelId);
      case "compatible":
        return createOpenAICompatible({
          name: "compatible",
          apiKey: target.apiKey,
          baseURL: target.endpoint!,
        })(target.modelId);
    }
  })();
  const result = await generateText({ model: languageModel, prompt, maxRetries: 0, maxOutputTokens: 32 });
  return result.text;
}

describe("budgets guard real provider calls", () => {
  let db: Knex;
  let fixtures: ProviderFixture;
  let registry: ModelRegistry;
  let budgets: Budgets;

  beforeAll(async () => {
    fixtures = await startProviderFixtures();
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    registry = createModelRegistry({
      db,
      cipher: createSecretCipher({ key: INSTALLATION_SECRET }),
      probe: async () => err({ kind: "provider-unavailable", message: "not used here" }),
    });
    budgets = createBudgets({ db, resolveModel: (principal) => registry.resolve(principal) });
  });

  beforeEach(async () => {
    fixtures.reset();
    await db("budget_reservations").delete();
    await db("budget_periods").delete();
    await db("budget_allowances").delete();
    await db("workspace_budget_permissions").delete();
    await db("workspace_personal_key_consents").delete();
    await db("workspace_model_settings").delete();
    await db("workspace_model_credentials").delete();
    await db("installation_model_settings").delete();
    await db("installation_model_credentials").delete();
    await db("workspace_memberships").delete();
    await db("workspaces").delete();
    await db("user").delete();
    await db("user").insert([
      { id: ADMIN, name: "Ada Admin", email: "ada-adapter@example.nl" },
      { id: SHOPPER, name: "Sam Shopper", email: "sam-adapter@example.nl" },
    ]);
    await db("workspaces").insert([
      { id: ADMIN_WORKSPACE, name: "Admin workspace", created_by_user_id: ADMIN },
      { id: SHOPPER_WORKSPACE, name: "Shopper workspace", created_by_user_id: SHOPPER },
    ]);
    await db("workspace_memberships").insert([
      { workspace_id: ADMIN_WORKSPACE, user_id: ADMIN, role: "owner" },
      { workspace_id: SHOPPER_WORKSPACE, user_id: SHOPPER, role: "owner" },
    ]);
    await registry.saveInstallation(administrator, {
      defaultModel: {
        provider: "compatible",
        modelId: "fixture-model-complete",
        endpoint: `${fixtures.baseUrl}/compatible/v1`,
      },
      usageSource: "installation",
      extractionOverride: null,
      apiKey: INSTALLATION_KEY,
    });
  });

  afterAll(async () => {
    await fixtures.close();
    await db.destroy();
  });

  /** The model the registry resolves; a refusal fails the test loudly. */
  async function resolvedFor(principal: Principal): Promise<ResolvedModel> {
    const resolved = await registry.resolve(principal);
    if (!resolved.ok) throw new Error(`model resolution refused: ${resolved.error.kind}`);
    return resolved.value;
  }

  it("lets an allowed call reach the provider and charge the allowance", async () => {
    await budgets.saveAllowance(administrator, {
      installation: { pool: "interactive", maxCalls: 2, maxTokens: 100_000, maxCents: 100 },
    });
    const granted = await budgets.reserve(shopper, {
      pool: "interactive",
      model: await resolvedFor(shopper),
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    const answer = await callProvider(granted.value.model, "Say ok.");
    expect(answer).toBe("fixture text ok");
    expect(fixtures.requests).toHaveLength(1);
    // The installation key travelled to the installation's configured endpoint.
    expect(fixtures.requests[0]!.authorization).toBe(`Bearer ${INSTALLATION_KEY}`);
    expect(fixtures.requests.every((request) => request.path === "/compatible/v1/chat/completions")).toBe(true);

    const settled = await budgets.settle(shopper, { reservationId: granted.value.reservation.id });
    expect(settled.ok).toBe(true);
    const usage = await budgets.read(shopper);
    expect(usage.ok).toBe(true);
    if (!usage.ok) return;
    expect(usage.value.pools[0]!.usage.calls).toBe(1);
  });

  it("makes zero provider requests once the interactive allowance is spent", async () => {
    await budgets.saveAllowance(administrator, {
      installation: { pool: "interactive", maxCalls: 1, maxTokens: 100_000, maxCents: 100 },
    });
    const model = await resolvedFor(shopper);

    const first = await budgets.reserve(shopper, { pool: "interactive", model });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await callProvider(first.value.model, "Say ok.");
    await budgets.settle(shopper, { reservationId: first.value.reservation.id });
    expect(fixtures.requests).toHaveLength(1);

    // The allowance is spent. A second caller is refused before dispatch, so
    // no request reaches the provider at all — not the configured model, not
    // another provider, not another key.
    const paused = await budgets.reserve(shopper, { pool: "interactive", model });
    expect(paused).toEqual({
      ok: false,
      error: {
        kind: "budget-exhausted",
        pool: "interactive",
        reason: "calls-exhausted",
        unit: "calls",
        limit: 1,
        used: 1,
      },
    });
    expect(fixtures.requests).toHaveLength(1);
  });

  it("pauses background work on a personal key with zero provider requests", async () => {
    await registry.saveWorkspace(shopper, {
      defaultModel: {
        provider: "compatible",
        modelId: "fixture-model-complete",
        endpoint: `${fixtures.baseUrl}/compatible/v1`,
      },
      usageSource: "workspace",
      extractionOverride: null,
      apiKey: WORKSPACE_KEY,
    });
    const model = await resolvedFor(shopper);
    expect(model.usageSource).toBe("workspace");

    const paused = await budgets.reserve(shopper, { pool: "background", model });
    expect(paused).toEqual({ ok: false, error: { kind: "budget-consent-required", pool: "background" } });
    // The shopper's own key was never spent while they were not watching.
    expect(fixtures.requests).toEqual([]);

    await budgets.setPersonalKeyBackgroundConsent(shopper, true);
    const granted = await budgets.reserve(shopper, { pool: "background", model });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    await callProvider(granted.value.model, "Say ok.");
    expect(fixtures.requests).toHaveLength(1);
    expect(fixtures.requests[0]!.authorization).toBe(`Bearer ${WORKSPACE_KEY}`);
  });

  it("counts a cancelled call after dispatch and frees one cancelled before it", async () => {
    await budgets.saveAllowance(administrator, {
      installation: { pool: "interactive", maxCalls: 2, maxTokens: 100_000, maxCents: 100 },
    });
    const model = await resolvedFor(shopper);

    // Cancelled before dispatch: nothing is spent and nothing is sent.
    const early = await budgets.reserve(shopper, { pool: "interactive", model });
    if (!early.ok) throw new Error("expected a grant");
    await budgets.release(shopper, early.value.reservation.id);
    expect(fixtures.requests).toEqual([]);

    // Cancelled after dispatch: the provider was already paid, so it counts.
    const late = await budgets.reserve(shopper, { pool: "interactive", model });
    if (!late.ok) throw new Error("expected a grant");
    await callProvider(late.value.model, "Say ok.");
    await budgets.settle(shopper, { reservationId: late.value.reservation.id });
    expect(fixtures.requests).toHaveLength(1);

    const usage = await budgets.read(shopper);
    expect(usage.ok && usage.value.pools[0]!.usage.calls).toBe(1);
  });
});
