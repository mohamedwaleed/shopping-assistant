import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * How an installation reaches a model. The three launch routes speak different
 * wire protocols even when they look alike, so the route is part of the
 * operator's configuration rather than guessed from a base URL: a wrong guess
 * would surface as a runtime failure in the middle of a conversation.
 *
 * - `openai` is OpenAI's own Responses API.
 * - `openai-compatible` is any server that speaks the Chat Completions API.
 * - `openrouter` is OpenRouter, which is Chat Completions plus its attribution
 *   headers; it is a separate route because those headers are required and
 *   because its model ids are namespaced by the upstream provider.
 */
export type ProviderRoute = "openai" | "openai-compatible" | "openrouter";

/**
 * One model the operator has configured, under the id an admin chooses. The
 * credential is not part of it: it belongs to the provider entry the model
 * points at, so a credential is written once and never repeated per model.
 */
export interface ConfiguredModel {
  /** The offered model id an admin selects, e.g. `balanced`. */
  id: string;
  /** The model name the provider expects, e.g. `gpt-5-mini`. */
  model: string;
  /** Which provider entry carries this model's endpoint and credential. */
  provider: string;
  /**
   * The provider's price in cents per million tokens, as a pair. Absent when
   * the operator does not know it, which is recorded as an unpriced call rather
   * than as a free one.
   */
  pricePerMillionTokens?: { inputCents: number; outputCents: number };
}

/** How to reach one provider: its route, its endpoint, and its credential. */
export interface ProviderConfiguration {
  /** Operator's name for the provider, referenced by `ConfiguredModel.provider`. */
  id: string;
  route: ProviderRoute;
  /** Secret. It is only ever passed to the provider, never returned or logged. */
  apiKey?: string;
  /**
   * The endpoint, for routes that need one stated: an OpenAI-compatible server
   * has no default, and an OpenRouter proxy or a regional OpenAI endpoint is
   * reached by naming it. Absent means the route's own public endpoint.
   */
  baseUrl?: string;
  /** Where OpenRouter should attribute traffic from this installation. */
  attribution?: { siteUrl?: string; appName?: string };
}

/**
 * Everything the agent package needs from the operator's environment. It is
 * deliberately a separate shape from the engine's own service configuration:
 * the engine decides what is offered and allowed, while this decides how a
 * chosen model is actually reached.
 */
export interface ModelConfiguration {
  providers: ProviderConfiguration[];
  models: ConfiguredModel[];
}

/** Raised when configuration names something that cannot be reached. */
export class ModelConfigurationError extends Error {
  constructor(problem: string) {
    super(`Invalid model configuration: ${problem}`);
    this.name = "ModelConfigurationError";
  }
}

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Where each route's requests go. A route with no default endpoint must be
 * given one, because there is no single server to assume for it.
 */
export function endpointOf(provider: ProviderConfiguration): string {
  const stated = provider.baseUrl?.replace(/\/+$/, "");
  if (stated) return stated;
  if (provider.route === "openai") return DEFAULT_OPENAI_BASE_URL;
  if (provider.route === "openrouter") return DEFAULT_OPENROUTER_BASE_URL;
  throw new ModelConfigurationError("an openai-compatible provider needs a baseUrl");
}

/**
 * A provider entry is usable only when it names a route and carries the
 * credential that route authenticates with. OpenRouter is never reached
 * anonymously, and neither is OpenAI; an OpenAI-compatible server may be, since
 * a self-hosted endpoint sometimes sits behind its own network controls.
 */
export function providerReadiness(provider: ProviderConfiguration): {
  ready: boolean;
  problem?: string;
} {
  if (!provider.apiKey) {
    return { ready: false, problem: "no credential is configured" };
  }
  try {
    endpointOf(provider);
  } catch {
    return { ready: false, problem: "no endpoint is configured" };
  }
  return { ready: true };
}

/**
 * Builds the AI SDK model for one configured model. This is the only place in
 * the repository that constructs an inference client, which is what keeps the
 * provider transport out of the engine: the engine names a model id, and this
 * turns that id into a transport here.
 */
export function languageModelOf(
  configuration: ModelConfiguration,
  modelId: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): LanguageModel {
  const model = configuration.models.find((candidate) => candidate.id === modelId);
  if (!model) throw new ModelConfigurationError(`no model is configured as ${modelId}`);
  const provider = configuration.providers.find((candidate) => candidate.id === model.provider);
  if (!provider) {
    throw new ModelConfigurationError(`model ${modelId} names an unconfigured provider`);
  }
  const readiness = providerReadiness(provider);
  if (!readiness.ready) {
    throw new ModelConfigurationError(
      `provider ${provider.id} is not ready: ${readiness.problem ?? "unknown problem"}`,
    );
  }

  const baseURL = endpointOf(provider);
  // `providerReadiness` above proved the credential is present; the SDK's own
  // type allows it to be absent so a caller can fall back to an environment
  // variable, which this package deliberately never does.
  const apiKey = provider.apiKey as string;
  const transport = options.fetch ? { fetch: options.fetch } : {};
  switch (provider.route) {
    case "openai":
      // The Chat Completions API rather than the Responses API: the Responses
      // API is OpenAI's own, and a conversation that also has to run on a
      // compatible endpoint behaves identically on both when both are chat.
      return createOpenAI({ apiKey, baseURL, ...transport }).chat(model.model);
    case "openai-compatible":
      return createOpenAICompatible({
        name: provider.id,
        baseURL,
        apiKey,
        // Token counts in a streamed answer are what a call is charged on, so
        // the compatible route asks for them explicitly.
        includeUsage: true,
        ...transport,
      }).chatModel(model.model);
    case "openrouter": {
      // OpenRouter attributes traffic by these two headers, and asks clients to
      // send them; without them the installation is an anonymous caller.
      const headers: Record<string, string> = {};
      if (provider.attribution?.siteUrl) headers["HTTP-Referer"] = provider.attribution.siteUrl;
      if (provider.attribution?.appName) headers["X-Title"] = provider.attribution.appName;
      return createOpenAICompatible({
        name: provider.id,
        baseURL,
        apiKey,
        includeUsage: true,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...transport,
      }).chatModel(model.model);
    }
  }
}
