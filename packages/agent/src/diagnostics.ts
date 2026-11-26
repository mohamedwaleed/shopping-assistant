import {
  APICallError,
  generateText,
  jsonSchema,
  JSONParseError,
  streamText,
  ToolChoiceViolationError,
  TypeValidationError,
  type ToolSet,
} from "ai";
import { languageModelOf, type ModelConfiguration } from "./providers.ts";

/**
 * The bounds a diagnostic works within. A diagnostic spends the operator's
 * money, so it is limited on every axis it can spend: how much it may output,
 * how long it may take, and how many calls it may make. It never retries,
 * because a retry is another call the operator pays for and a failing provider
 * will usually fail again.
 */
export interface DiagnosticBounds {
  maxOutputTokens: number;
  timeoutMs: number;
  /** Wall-clock allowance for the whole diagnostic, both calls included. */
  totalTimeoutMs: number;
}

export const DEFAULT_DIAGNOSTIC_BOUNDS: DiagnosticBounds = {
  maxOutputTokens: 64,
  timeoutMs: 15_000,
  totalTimeoutMs: 30_000,
};

/**
 * What the diagnostic asked the model to do, and what came back. Capabilities
 * are reported as proven or not: `supported` only when the provider actually
 * produced a streamed answer or a well-formed call to the declared tool, never
 * because the endpoint accepted a connection.
 */
export type CapabilityVerdict =
  /** Exercised, and the provider did what the conversation needs. */
  | "supported"
  /** Exercised, and the provider did not do it. */
  | "unsupported"
  /** Not exercised, because something earlier in the diagnostic failed. */
  | "not-exercised";

export type DiagnosticStatus =
  /** Every capability the conversation needs was proven. */
  | "ready"
  /** The provider answered, but not in the shape the conversation needs. */
  | "incompatible"
  /** The credential the route needs is not configured. */
  | "unconfigured"
  /** The provider refused or failed; the message says which. */
  | "failed";

export interface DiagnosticReport {
  status: DiagnosticStatus;
  model: { id: string; provider: string; model: string; route: string };
  capabilities: { streaming: CapabilityVerdict; toolCalling: CapabilityVerdict };
  /** Token counts the provider reported, which is what the call is charged on. */
  usage: { inputTokens: number; outputTokens: number };
  /** How long the diagnostic took, so its share of the allowance is visible. */
  durationMs: number;
  /** What went wrong, in the operator's words. Never a credential or a payload. */
  problem?: string;
}

/** Raised when the diagnostic names a model the operator has not configured. */
export class UnknownModelError extends Error {
  constructor(modelId: string) {
    super(`No model is configured as ${modelId}`);
    this.name = "UnknownModelError";
  }
}

/**
 * The tool a diagnostic asks the model to call. It is a real typed tool with a
 * declared schema, not a prompt asking for JSON: the point of the check is that
 * the provider returns a call whose arguments satisfy a schema the agent
 * declares, which is what a shopping tool needs at runtime.
 *
 * The tool is written out as a `ToolSet` member rather than through `tool()`,
 * which leaves the output schema `never` and is not assignable to the SDK's
 * tool set under `exactOptionalPropertyTypes`. A diagnostic never executes the
 * call, so an output schema would be noise.
 */
export const DIAGNOSTIC_TOOL_NAME = "record_product_interest";

const diagnosticTool: ToolSet[string] = {
  description:
    "Record that the shopper is interested in a product category. Call this exactly once.",
  inputSchema: jsonSchema<{ category: string; mustBeInStock: boolean }>({
    type: "object",
    properties: {
      category: { type: "string", description: "The product category to record." },
      mustBeInStock: { type: "boolean", description: "Whether only in-stock offers qualify." },
    },
    required: ["category", "mustBeInStock"],
    additionalProperties: false,
  }),
};

const diagnosticTools: ToolSet = { [DIAGNOSTIC_TOOL_NAME]: diagnosticTool };

/**
 * Why a provider call failed, in terms an operator can act on. The text is
 * built from status and error kind only: a provider's own message can echo the
 * request, and the request carries the prompt and the credential's headers.
 */
function describeFailure(error: unknown): { status: DiagnosticStatus; problem: string } {
  if (error instanceof APICallError) {
    const code = error.statusCode;
    if (code === 401 || code === 403) {
      return { status: "failed", problem: `the provider rejected the credential (${code})` };
    }
    if (code === 404) {
      return { status: "failed", problem: "the provider has no such model or endpoint (404)" };
    }
    if (code === 429) {
      return { status: "failed", problem: "the provider is rate limiting this installation (429)" };
    }
    // A 2xx whose body the adapter could not read is not a provider failure but
    // a protocol one: something answered, and it did not speak this route.
    if (error.cause instanceof JSONParseError || error.cause instanceof TypeValidationError) {
      return {
        status: "incompatible",
        problem: "the provider's response did not match the protocol the route expects",
      };
    }
    return {
      status: "failed",
      problem: `the provider answered with an error${code === undefined ? "" : ` (${code})`}`,
    };
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return {
        status: "failed",
        problem: "the provider did not answer within the diagnostic's time",
      };
    }
    // Anything else is a protocol mismatch: a response the adapter could not
    // read means the endpoint does not speak the route's protocol.
    return {
      status: "incompatible",
      problem: "the provider's response did not match the protocol the route expects",
    };
  }
  return { status: "failed", problem: "the provider failed in a way that could not be identified" };
}

/** Token counts, whichever of the SDK's two shapes the call reported. */
function tokensOf(usage: { inputTokens?: number | undefined; outputTokens?: number | undefined }): {
  inputTokens: number;
  outputTokens: number;
} {
  return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
}

/**
 * Exercises a configured model and reports what it actually does.
 *
 * Two capabilities are checked, because a conversation needs both and neither
 * follows from the other:
 *
 * 1. Streaming: the answer must arrive as a stream of deltas, which is what
 *    lets a shopper see the assistant thinking rather than waiting.
 * 2. A typed tool call: the model must return a call to a declared tool whose
 *    arguments satisfy the declared schema. A provider that ignores the schema,
 *    or that answers with prose, fails this even if it streams perfectly.
 *
 * Endpoint compatibility proves neither. A server can accept the request,
 * answer 200, and still be unable to stream or to call tools, so the verdict
 * comes from the streamed parts and the validated call, and nothing else.
 */
export async function diagnoseModel({
  configuration,
  modelId,
  bounds = DEFAULT_DIAGNOSTIC_BOUNDS,
  fetch,
  now = () => Date.now(),
  onAttempt = () => {},
}: {
  configuration: ModelConfiguration;
  modelId: string;
  bounds?: DiagnosticBounds;
  /** A transport, so a test can answer from recorded bodies instead of a network. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * Called just before each call leaves, so the caller knows the provider was
   * asked and can no longer give its reservation back for free.
   */
  onAttempt?: () => void;
}): Promise<DiagnosticReport> {
  const model = configuration.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new UnknownModelError(modelId);
  const provider = configuration.providers.find((candidate) => candidate.id === model.provider);
  const identity = {
    id: model.id,
    provider: model.provider,
    model: model.model,
    route: provider?.route ?? "unknown",
  };
  const started = now();
  const base = {
    model: identity,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const elapsed = () => now() - started;

  if (!provider) {
    return {
      ...base,
      status: "unconfigured",
      capabilities: { streaming: "not-exercised", toolCalling: "not-exercised" },
      durationMs: elapsed(),
      problem: `the provider ${model.provider} is not configured`,
    };
  }
  if (!provider.apiKey) {
    return {
      ...base,
      status: "unconfigured",
      capabilities: { streaming: "not-exercised", toolCalling: "not-exercised" },
      durationMs: elapsed(),
      problem: `the provider ${model.provider} has no credential configured`,
    };
  }
  const languageModel = languageModelOf(configuration, modelId, fetch ? { fetch } : {});
  const signal = AbortSignal.timeout(bounds.totalTimeoutMs);

  let usage = { inputTokens: 0, outputTokens: 0 };

  // Streaming first: it needs no tool support, so a provider that cannot stream
  // is reported as such rather than as a tool failure.
  try {
    onAttempt();
    const streamed = streamText({
      model: languageModel,
      prompt: "Reply with the single word: ready.",
      maxOutputTokens: bounds.maxOutputTokens,
      // One call, one charge: a retry would be a second call the operator pays
      // for, and the diagnostic must not spend beyond its own bounds.
      maxRetries: 0,
      timeout: bounds.timeoutMs,
      abortSignal: signal,
    });
    let deltas = 0;
    let streamedText = "";
    // A streaming failure arrives as an `error` part rather than as a rejected
    // promise, so it is collected here: reading only the deltas would report a
    // rejected credential as "did not stream", which is the wrong diagnosis.
    let streamFailure: unknown;
    for await (const part of streamed.fullStream) {
      if (part.type === "text-delta") {
        deltas += 1;
        streamedText += part.text;
      }
      if (part.type === "error") streamFailure = part.error;
    }
    if (streamFailure !== undefined) throw streamFailure;
    usage = tokensOf(await streamed.totalUsage);
    // One delta is a whole answer delivered in one piece, which is what a
    // provider without streaming does. Streaming means several, arriving as the
    // answer is produced.
    if (deltas < 2 || streamedText.trim().length === 0) {
      return {
        ...base,
        usage,
        status: "incompatible",
        capabilities: { streaming: "unsupported", toolCalling: "not-exercised" },
        durationMs: elapsed(),
        problem: "the provider answered without streaming the answer in parts",
      };
    }
  } catch (error) {
    const failure = describeFailure(error);
    return {
      ...base,
      usage,
      status: failure.status,
      capabilities: { streaming: "unsupported", toolCalling: "not-exercised" },
      durationMs: elapsed(),
      problem: failure.problem,
    };
  }

  try {
    onAttempt();
    const answered = await generateText({
      model: languageModel,
      tools: diagnosticTools,
      // The tool is demanded rather than suggested: a provider that supports
      // tools will call it, and one that ignores the choice is exactly what
      // this check is for.
      toolChoice: { type: "tool", toolName: DIAGNOSTIC_TOOL_NAME },
      prompt: "Record the shopper's interest in bike helmets, in stock only.",
      maxOutputTokens: bounds.maxOutputTokens,
      maxRetries: 0,
      timeout: bounds.timeoutMs,
      abortSignal: signal,
    });
    const second = tokensOf(answered.totalUsage);
    usage = {
      inputTokens: usage.inputTokens + second.inputTokens,
      outputTokens: usage.outputTokens + second.outputTokens,
    };
    const call = answered.toolCalls.find(
      (candidate) => candidate.toolName === DIAGNOSTIC_TOOL_NAME,
    );
    const input = call?.input as { category?: unknown; mustBeInStock?: unknown } | undefined;
    const wellTyped =
      typeof input?.category === "string" && typeof input.mustBeInStock === "boolean";
    if (!call || !wellTyped) {
      return {
        ...base,
        usage,
        status: "incompatible",
        capabilities: { streaming: "supported", toolCalling: "unsupported" },
        durationMs: elapsed(),
        problem: call
          ? "the provider called the tool with arguments the declared schema does not allow"
          : "the provider answered without calling the declared tool",
      };
    }
  } catch (error) {
    // The SDK refuses an answer that ignored a demanded tool call. That is the
    // clearest statement of "no tool support" there is, and it is not a
    // provider failure, so it is reported as a missing capability.
    if (error instanceof ToolChoiceViolationError) {
      return {
        ...base,
        usage,
        status: "incompatible",
        capabilities: { streaming: "supported", toolCalling: "unsupported" },
        durationMs: elapsed(),
        problem: "the provider answered without calling the declared tool",
      };
    }
    const failure = describeFailure(error);
    return {
      ...base,
      usage,
      status: failure.status,
      capabilities: { streaming: "supported", toolCalling: "unsupported" },
      durationMs: elapsed(),
      problem: failure.problem,
    };
  }

  return {
    ...base,
    usage,
    status: "ready",
    capabilities: { streaming: "supported", toolCalling: "supported" },
    durationMs: elapsed(),
  };
}
