// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatGPTPlanExercise } from "@shopping/core";
import {
  createChatGPTPlanExercise,
  PLAN_MAX_STEPS,
  PLAN_RESPONSES_BASE_URL,
} from "@/lib/models/ai-sdk-probe";
import {
  credentialsSeen,
  PLAN_FAILED_STREAM_TOKEN,
  PLAN_FIXTURE_TOKENS,
  startProviderFixtures,
  type ProviderFixture,
} from "./support/provider-fixtures";

/**
 * The ChatGPT plan route is the Responses API with its own requirements
 * (store: false, stream: true, namespaced function tools, no unsupported
 * parameters). This suite proves the pinned AI SDK adapter satisfies them on
 * the wire and that a shopping tool step really executes — not merely that a
 * text ping returned something.
 */
const PLAN_MODEL = "gpt-6.2-sol";

let fixtures: ProviderFixture;

beforeAll(async () => {
  fixtures = await startProviderFixtures();
});

beforeEach(() => {
  fixtures.reset();
});

afterAll(async () => {
  await fixtures.close();
});

/** A plan request, with the fixture's eligible token and shopping tool by default. */
function exercisePlan(
  overrides: Partial<ChatGPTPlanExercise> = {},
) {
  const exercise = createChatGPTPlanExercise({
    baseUrl: `${fixtures.baseUrl}/openai/v1`,
    ...overrides,
  });
  return exercise({
    connection: {
      accessToken: PLAN_FIXTURE_TOKENS.eligible,
      workspaceId: "22222222-2222-4222-8222-222222222222",
      modelId: PLAN_MODEL,
    },
    prompt: "Call the requirements_update tool for this shopping request.",
    tools: ["requirements_update"],
    ...overrides,
  });
}

describe("ChatGPT plan Responses conformance", () => {
  it("sends a request the plan route accepts and completes a typed tool step", async () => {
    const result = await exercisePlan();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The tool was called *and executed*: a text-only ping would leave
    // `toolsExecuted` empty, so this is proof of the tool step, not a ping.
    // The fixture keeps calling the tool until the step bound, so every call
    // is matched by an execution.
    expect(result.value).toMatchObject({ completed: true });
    expect(result.value.toolCalls.length).toBeGreaterThan(0);
    expect(new Set(result.value.toolCalls)).toEqual(new Set(["requirements_update"]));
    expect(result.value.toolsExecuted).toEqual(result.value.toolCalls);
    expect(result.value.toolCalls.length).toBeLessThanOrEqual(PLAN_MAX_STEPS);

    // The documented requirements, checked on the wire rather than assumed.
    expect(fixtures.planChecks.length).toBeGreaterThan(0);
    for (const check of fixtures.planChecks) {
      expect(check.store).toBe(false);
      expect(check.stream).toBe(true);
      expect(check.unsupportedFields).toEqual([]);
      expect(check.toolNamespaces).toContain("shopping");
      expect(check.bareTools).toBe(0);
      expect(check.inputIsArray).toBe(true);
      // A system instruction travels as developer instructions, never as a
      // `{type:"message", role:"system"}` input item.
      expect(check.systemMessageItem).toBe(false);
      expect(check.developerInstructions).toBe(true);
    }

    // Every call went to the documented public Responses endpoint, and the
    // plan token travelled only as a bearer header.
    expect(fixtures.requests.every((request) => request.path === "/openai/v1/responses")).toBe(true);
    expect(credentialsSeen(fixtures.requests)).toEqual(
      fixtures.requests.map(() => PLAN_FIXTURE_TOKENS.eligible),
    );
    expect(JSON.stringify(fixtures.requests.map((request) => request.body))).not.toContain(
      PLAN_FIXTURE_TOKENS.eligible,
    );
  });

  it("supplies the conversation as the input array, not as a stored response", async () => {
    // The plan route rejects `previous_response_id` and stores nothing, so the
    // history the caller holds has to travel with the request.
    const result = await exercisePlan({
      messages: [
        { role: "user", content: "Ik zoek een laptop" },
        { role: "assistant", content: "Waar gebruik je hem voor?" },
      ],
      prompt: "Voor studie, onder €1000.",
    });
    expect(result.ok).toBe(true);
    const body = fixtures.requests.at(-1)?.body as {
      input?: Array<{ role?: string; type?: string }>;
      previous_response_id?: unknown;
    };
    expect(body.previous_response_id).toBeUndefined();
    const roles = (body.input ?? []).map((item) => item.role ?? item.type);
    // The instruction, then the conversation in order; the tool loop may add
    // further turns after it.
    expect(roles.slice(0, 4)).toEqual(["developer", "user", "assistant", "user"]);
  });

  it("names the documented public Responses endpoint", () => {
    expect(PLAN_RESPONSES_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("never asks for an output-token bound the plan route forbids", async () => {
    await exercisePlan();
    const requested = fixtures.requests.map(
      (request) => request.body.max_output_tokens ?? request.body.max_tokens,
    );
    expect(requested.every((value) => value === undefined)).toBe(true);
  });

  it("maps an exhausted plan allowance to the typed usage-limit outcome", async () => {
    const result = await exercisePlan({
      connection: {
        accessToken: PLAN_FIXTURE_TOKENS.usageLimit,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: PLAN_MODEL,
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "chatgpt-plan-request-failed", code: "subscription_sharing_usage_limit_exceeded", status: 429 },
    });
  });

  it("maps an ineligible account to the provider's own code", async () => {
    const result = await exercisePlan({
      connection: {
        accessToken: PLAN_FIXTURE_TOKENS.notEligible,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: PLAN_MODEL,
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "chatgpt-plan-request-failed", code: "subscription_sharing_user_not_eligible", status: 403 },
    });
  });

  it("reports an expired access token as an expired grant, not a retry", async () => {
    const result = await exercisePlan({
      connection: {
        accessToken: PLAN_FIXTURE_TOKENS.expired,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: PLAN_MODEL,
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "chatgpt-plan-request-failed", code: "token_expired", status: 401 },
    });
  });

  it("refuses to spend an API key on the plan route", async () => {
    // The adapter is handed an API key where a plan token belongs. The fixture
    // rejects it, and the adapter surfaces the provider's code unchanged: no
    // silent switch to API-key billing.
    const result = await exercisePlan({
      connection: {
        accessToken: "sk-api-key-must-not-be-spent",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: PLAN_MODEL,
      },
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "chatgpt-plan-request-failed", code: "subscription_sharing_invalid_user", status: 401 },
    });
  });

  it("does not report a text-only answer as a working tool step", async () => {
    const result = await exercisePlan({
      prompt: "Describe what you need.",
      tools: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.completed).toBe(true);
    expect(result.value.text).toContain("fixture plan ok");
    expect(result.value.toolCalls).toEqual([]);
    expect(result.value.toolsExecuted).toEqual([]);
  });

  it("treats a stream that never completes as a failed request", async () => {
    // The provider can end a stream without `response.completed`; an empty
    // answer must not be recorded as a successful plan request.
    const result = await exercisePlan({
      connection: {
        accessToken: PLAN_FAILED_STREAM_TOKEN,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: PLAN_MODEL,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("chatgpt-plan-request-failed");
  });

  it("reports an unreachable endpoint as a typed error, never a thrown one", async () => {
    const exercise = createChatGPTPlanExercise({ baseUrl: "http://127.0.0.1:9/v1" });
    const result = await exercise({
      connection: {
        accessToken: PLAN_FIXTURE_TOKENS.eligible,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: PLAN_MODEL,
      },
      prompt: "hello",
      tools: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("chatgpt-plan-request-failed");
    expect(JSON.stringify(result)).not.toContain(PLAN_FIXTURE_TOKENS.eligible);
  });

  it("rejects a plan target without a model", async () => {
    const exercise = createChatGPTPlanExercise({ baseUrl: `${fixtures.baseUrl}/openai/v1` });
    const result = await exercise({
      connection: {
        accessToken: PLAN_FIXTURE_TOKENS.eligible,
        workspaceId: "22222222-2222-4222-8222-222222222222",
        modelId: "",
      },
      prompt: "hello",
      tools: [],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "modelId",
        message: "a ChatGPT plan request needs a model from the account's own list",
      },
    });
    expect(fixtures.requests).toEqual([]);
  });
});
