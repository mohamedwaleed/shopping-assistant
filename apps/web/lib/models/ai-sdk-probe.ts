// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  stepCountIs,
  streamText,
  tool,
  type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  err,
  ok,
  type CapabilityReport,
  type CapabilityState,
  type ChatGPTPlanExercise,
  type ChatGPTPlanExerciseFn,
  type ChatGPTPlanExerciseResult,
  type CoreError,
  type ModelProbe,
  type ModelProbeRequest,
  type ModelTarget,
  type Result,
} from "@shopping/core";
import type { LanguageModel, ModelMessage } from "ai";

/**
 * AI SDK packages this adapter is verified against (docs/adr/0012). Pinned so a
 * provider protocol change cannot arrive unnoticed: the fixture suite fails if
 * the wire format moves, and a live smoke check confirms a real endpoint.
 */
export const MODEL_ADAPTER_PINS = {
  ai: "7.0.172",
  openai: "@ai-sdk/openai@4.0.118",
  anthropic: "@ai-sdk/anthropic@4.0.105",
  compatible: "@ai-sdk/openai-compatible@3.0.92",
} as const;

/** Network timeout per diagnostic call; a slow endpoint cannot hold settings. */
export const DIAGNOSTIC_TIMEOUT_MS = 15_000;

const TOOL_PROBE_PROMPT =
  "Capability probe. Call the capability_probe tool with value \"fixture\" and nothing else.";
const STRUCTURED_PROBE_PROMPT =
  "Capability probe. Report the probe value through the required structured output.";
const TEXT_PROBE_PROMPT = "Capability probe. Reply with the word ok.";

/**
 * The schema the structured-output check enforces. `answer` is a required
 * string, so an endpoint that only emits JSON-shaped prose, or a different
 * shape, fails validation instead of passing.
 */
const STRUCTURED_PROBE_SCHEMA = jsonSchema<{ answer: string }>({
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
});

/** The typed tool whose execution proves the endpoint honours tool calls. */
function probeTools(): ToolSet {
  return {
    capability_probe: tool({
      description: "Echo the probe value back to the caller.",
      inputSchema: jsonSchema<{ value: string }>({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      }),
      execute: async ({ value }) => ({ echoed: value }),
    }),
  };
}

/** Shared server-only provider adapter; core supplies the resolved, authorized target. */
export function languageModel(target: ModelTarget, apiKey: string): LanguageModel {
  switch (target.provider) {
    case "openai": {
      const provider = createOpenAI({
        apiKey,
        ...(target.endpoint ? { baseURL: target.endpoint } : {}),
      });
      // The Responses API carries the typed tool schema the chat route does not.
      return provider(target.modelId);
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey,
        ...(target.endpoint ? { baseURL: target.endpoint } : {}),
      });
      return provider(target.modelId);
    }
    case "compatible": {
      // Guarded before the switch: a compatible target always has an endpoint.
      const endpoint = target.endpoint!;
      const provider = createOpenAICompatible({
        name: "compatible",
        apiKey,
        baseURL: endpoint,
      });
      return provider(target.modelId);
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Run one bounded check. Every call uses the diagnostic's token bound, zero SDK
 * retries and a network timeout, so the call budget in `bounds` is the real
 * ceiling rather than a convention.
 */
function callOptions(bounds: ModelProbeRequest["bounds"]) {
  return {
    maxOutputTokens: bounds.maxOutputTokens,
    maxRetries: 0,
    timeout: DIAGNOSTIC_TIMEOUT_MS,
  };
}

export function createAiSdkProbe(): ModelProbe {
  return async (request: ModelProbeRequest): Promise<Result<CapabilityReport>> => {
    const { target, provider, apiKey, bounds } = request;
    // A stored key belongs to one provider. Handing it to another provider's
    // endpoint would leak it, so the adapter refuses instead of calling.
    if (provider !== target.provider) {
      return err({
        kind: "model-credential-provider-mismatch",
        provider: target.provider,
        credentialProvider: provider,
        source: "probe",
      });
    }
    if (target.provider === "compatible" && !target.endpoint) {
      return err({
        kind: "invalid-input",
        field: "endpoint",
        message: "a compatible endpoint requires a base URL",
      });
    }
    const capabilities: Record<keyof CapabilityReport["capabilities"], CapabilityState> = {
      text: "unsupported",
      tools: "unsupported",
      structuredOutput: "unsupported",
      streaming: "unsupported",
    };
    let error: CapabilityReport["error"];
    let calls = 0;

    const model = languageModel(target, apiKey);

    /** Charge one unit per model call; the tool check makes exactly one. */
    function reserve(): boolean {
      if (calls >= bounds.maxCalls) return false;
      calls += 1;
      return true;
    }

    // 1. Text: the cheapest call, and the first signal that the endpoint and
    //    credential work at all.
    if (reserve()) {
      try {
        const result = await generateText({
          model,
          prompt: TEXT_PROBE_PROMPT,
          ...callOptions(bounds),
        });
        if (result.text.trim().length > 0) capabilities.text = "supported";
      } catch (cause) {
        error = { kind: "provider-unavailable", message: messageOf(cause) };
      }
    }

    // 2. Typed tools: the model must actually call the tool and the SDK must
    //    execute it. A tool schema that is accepted but ignored fails here.
    if (!error && reserve()) {
      try {
        const result = await generateText({
          model,
          tools: probeTools(),
          // One step: the tool executes, but no follow-up call is made, so the
          // call bound stays exact.
          stopWhen: stepCountIs(1),
          prompt: TOOL_PROBE_PROMPT,
          ...callOptions(bounds),
        });
        if (result.toolResults.some((call) => call.toolName === "capability_probe")) {
          capabilities.tools = "supported";
        }
      } catch (cause) {
        error = { kind: "provider-unavailable", message: messageOf(cause) };
      }
    }

    // 3. Structured output: the SDK must send the response format (schema or
    //    JSON mode, per provider) and the reply must validate against the
    //    schema. JSON-shaped prose, or JSON of another shape, fails here.
    if (!error && reserve()) {
      try {
        const result = await generateText({
          model,
          output: Output.object({ schema: STRUCTURED_PROBE_SCHEMA }),
          prompt: STRUCTURED_PROBE_PROMPT,
          ...callOptions(bounds),
        });
        const structured = result.output;
        if (structured && typeof structured.answer === "string") {
          capabilities.structuredOutput = "supported";
        }
      } catch (cause) {
        // A schema violation is an observation about the endpoint, not a failed
        // diagnostic: the capability stays unsupported and the run continues.
        if (!NoObjectGeneratedError.isInstance(cause)) {
          error = { kind: "provider-unavailable", message: messageOf(cause) };
        }
      }
    }

    // 4. Streaming: deltas must arrive and finish, not merely return a body.
    if (!error && reserve()) {
      try {
        const result = streamText({
          model,
          prompt: TEXT_PROBE_PROMPT,
          ...callOptions(bounds),
        });
        const text = await result.text;
        if (text.trim().length > 0) capabilities.streaming = "supported";
      } catch (cause) {
        error = { kind: "provider-unavailable", message: messageOf(cause) };
      }
    }

    return ok({
      provider: target.provider,
      modelId: target.modelId,
      ...(target.endpoint ? { endpoint: target.endpoint } : {}),
      testedAt: new Date().toISOString(),
      bounds,
      capabilities,
      ...(error ? { error } : {}),
    });
  };
}

/**
 * The documented public Responses endpoint for ChatGPT plan usage. The plan
 * flow must use this route, not ChatGPT's internal endpoints.
 */
export const PLAN_RESPONSES_BASE_URL = "https://api.openai.com/v1";

/**
 * Optional endpoint override for the plan route. A self-hosted installation may
 * need to reach the provider through an egress proxy, and the test suite points
 * it at a loopback fixture; it is installation configuration, never a request
 * parameter.
 */
export const CHATGPT_PLAN_ENDPOINT_ENV = "CHATGPT_PLAN_RESPONSES_BASE_URL";

/** Namespace the shopping tools travel in; the plan route rejects bare tools. */
export const PLAN_TOOL_NAMESPACE = "shopping";

/** Tool calls the plan route accepts per request; a runaway loop is refused. */
export const PLAN_MAX_STEPS = 3;

export interface ChatGPTPlanAdapterOptions {
  /** Endpoint base URL; overridable only so loopback fixtures can stand in. */
  baseUrl?: string;
}

/**
 * ChatGPT plan usage through the pinned AI SDK OpenAI adapter (docs/adr/0013).
 *
 * The plan route is the Responses API with its own documented requirements, and
 * the adapter satisfies them explicitly instead of relying on provider
 * defaults: `store: false`, `stream: true`, the conversation supplied as an
 * `input` array, a developer instruction rather than a system input item, no
 * output-token bound (the plan route rejects `max_output_tokens`), and function
 * tools declared inside a namespace item rather than as bare top-level tools.
 * It returns observed facts — whether the stream reached `response.completed`,
 * which tools the model called and which the SDK executed — so a text-only
 * reply is never reported as a working tool step.
 */
export function createChatGPTPlanExercise(
  options: ChatGPTPlanAdapterOptions = {},
): ChatGPTPlanExerciseFn {
  return async (request: ChatGPTPlanExercise): Promise<Result<ChatGPTPlanExerciseResult>> => {
    const { connection, prompt } = request;
    if (!connection.modelId.trim()) {
      return err({
        kind: "invalid-input",
        field: "modelId",
        message: "a ChatGPT plan request needs a model from the account's own list",
      });
    }
    if (!connection.accessToken.trim()) {
      return err({ kind: "chatgpt-plan-disconnected" });
    }

    // The account's OAuth access token is the bearer credential; it is never
    // combined with, or replaced by, a stored API key.
    const provider = createOpenAI({
      apiKey: connection.accessToken,
      baseURL: options.baseUrl ?? PLAN_RESPONSES_BASE_URL,
    });

    const executed: string[] = [];
    const tools: ToolSet = {};
    for (const name of request.tools) {
      tools[name] = tool({
        description: `Shopping tool ${name}.`,
        inputSchema: PLAN_TOOL_SCHEMAS[name] ?? PLAN_FALLBACK_SCHEMA,
        // The plan route accepts function tools only inside a namespace, so
        // every shopping tool declares one rather than travelling as a bare
        // top-level function.
        providerOptions: {
          openai: { namespace: PLAN_TOOL_NAMESPACE_OPTION },
        },
        execute: async (input: unknown) => {
          // Executing the tool is the proof: a schema that is accepted but
          // ignored never reaches this point.
          executed.push(name);
          return { accepted: true, input };
        },
      });
    }

    // A plan request without history is a single prompt; with history the whole
    // conversation travels as messages, because the route rejects
    // `previous_response_id` and stores nothing.
    const promptInput = planPrompt(prompt, request.messages);
    // Every plan call carries the same documented requirements and bounds.
    const callOptions = {
      model: provider(connection.modelId),
      instructions: PLAN_INSTRUCTIONS,
      tools,
      stopWhen: stepCountIs(PLAN_MAX_STEPS),
      // One attempt: a retry would repeat a request the route already refused.
      maxRetries: 0,
      timeout: DIAGNOSTIC_TIMEOUT_MS,
      providerOptions: {
        openai: {
          // Required by the plan route on every HTTP inference request.
          store: false,
          systemMessageMode: "developer" as const,
          // No output-token bound is set: `max_output_tokens` is rejected.
        },
      },
    };
    let streamError: unknown = null;
    // A stream that ends without output carries its provider error here; reading
    // only the text would lose the provider's own error code.
    const onError = ({ error }: { error: unknown }) => {
      streamError = error;
    };
    try {
      const result =
        "messages" in promptInput
          ? streamText({ ...callOptions, messages: promptInput.messages, onError })
          : streamText({ ...callOptions, prompt: promptInput.prompt, onError });
      // Only a consumed stream reaches `response.completed`. A stream that ends
      // without it — an allowance exhausted mid-stream, an interrupted
      // connection — is a failed request, never a short answer.
      const [text, calls, usage, finishReason] = await Promise.all([
        result.text,
        result.toolCalls,
        result.usage,
        result.finishReason,
      ]);
      if (streamError) return err(planFailure(streamError));
      if (finishReason === "error") {
        return err({ kind: "chatgpt-plan-request-failed", code: null, status: 502 });
      }
      return ok({
        completed: true,
        text,
        toolCalls: calls.map((call) => call.toolName),
        toolsExecuted: [...executed],
        usage: {
          inputTokens: usage.inputTokens ?? null,
          outputTokens: usage.outputTokens ?? null,
        },
      });
    } catch (cause) {
      return err(planFailure(streamError ?? cause));
    }
  };
}

/**
 * The `input` array for one plan request: the history the caller already holds,
 * followed by the shopper's current turn. Nothing is stored at the provider
 * (`store: false`), so this array *is* the conversation.
 */
function planPrompt(
  prompt: string,
  history?: Array<{ role: "user" | "assistant"; content: string }>,
): { prompt: string } | { messages: ModelMessage[] } {
  if (!history || history.length === 0) return { prompt };
  return {
    messages: [
      ...history.map((message) => ({ role: message.role, content: message.content })),
      // The current turn is the last input item, so a history never replaces it.
      { role: "user" as const, content: prompt },
    ],
  };
}

const PLAN_INSTRUCTIONS =
  "You are a bilingual (English/Dutch) shopping assistant for shoppers in the Netherlands. " +
  "Call the requirements_update tool when the shopper describes or revises buying needs.";

/**
 * The plan route rejects bare top-level function tools; it accepts them grouped
 * in a namespace. The pinned adapter declares the namespace per tool, which the
 * SDK groups into one `type: "namespace"` entry on the wire.
 */
const PLAN_TOOL_NAMESPACE_OPTION = {
  name: PLAN_TOOL_NAMESPACE,
  description: "Shopping tools available to this conversation.",
};

/**
 * The plan route's structured errors carry a stable `error.code`. It is
 * preserved verbatim so the recovery action (pause, reauthorize, drop the
 * unsupported input) is chosen from the provider's own code rather than a
 * guess.
 */
function planFailure(cause: unknown): CoreError {
  const status =
    typeof (cause as { statusCode?: unknown }).statusCode === "number"
      ? (cause as { statusCode: number }).statusCode
      : 502;
  const body = (cause as { responseBody?: unknown }).responseBody;
  let code: string | null = null;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
      const value = parsed.error?.code ?? parsed.code;
      if (typeof value === "string") code = value;
    } catch {
      code = null;
    }
  }
  if (code === null && typeof (cause as { code?: unknown }).code === "string") {
    code = (cause as { code: string }).code;
  }
  return { kind: "chatgpt-plan-request-failed", code, status };
}

const PLAN_FALLBACK_SCHEMA = jsonSchema<Record<string, unknown>>({
  type: "object",
  properties: {},
  additionalProperties: true,
});

const PLAN_REQUIREMENTS_SCHEMA = jsonSchema<{
  mustHaves: string[];
  preferences: string[];
  assumptions: string[];
  questions: string[];
  revisionNote: string;
}>({
  type: "object",
  properties: {
    mustHaves: { type: "array", items: { type: "string" } },
    preferences: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    revisionNote: { type: "string" },
  },
  required: ["mustHaves", "preferences", "assumptions", "questions", "revisionNote"],
  additionalProperties: false,
});

const PLAN_TOOL_SCHEMAS: Record<string, ReturnType<typeof jsonSchema>> = {
  requirements_update: PLAN_REQUIREMENTS_SCHEMA,
};
