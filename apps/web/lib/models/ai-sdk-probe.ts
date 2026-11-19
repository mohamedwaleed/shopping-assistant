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
  type ModelProbe,
  type ModelProbeRequest,
  type ModelTarget,
  type Result,
} from "@shopping/core";

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

function languageModel(target: ModelTarget, apiKey: string) {
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
