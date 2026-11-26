import { describe, expect, it } from "vitest";
import { diagnoseModel, UnknownModelError } from "./diagnostics.ts";
import {
  endpointOf,
  languageModelOf,
  ModelConfigurationError,
  providerReadiness,
  type ModelConfiguration,
} from "./providers.ts";
import { recordedRequests } from "./fixtures/recorded.ts";
import {
  credentialRejected,
  fixtureTransport,
  notStreaming,
  rateLimited,
  toolIgnored,
  toolMisTyped,
  unknownModel,
  wellBehaved,
  wrongProtocol,
  type ProviderBehaviour,
} from "./fixtures/transport.ts";

const API_KEY = "sk-fixture-7f3a9c2e5b1d";

/** The three launch routes, each with the model id an admin would choose. */
const configuration: ModelConfiguration = {
  providers: [
    { id: "openai", route: "openai", apiKey: API_KEY },
    {
      id: "compatible",
      route: "openai-compatible",
      apiKey: API_KEY,
      baseUrl: "https://llm.example.com/v1",
    },
    {
      id: "openrouter",
      route: "openrouter",
      apiKey: API_KEY,
      attribution: { siteUrl: "http://localhost:3000", appName: "shopping-assistant" },
    },
  ],
  models: [
    { id: "balanced", provider: "openai", model: "gpt-4o-mini" },
    { id: "thorough", provider: "compatible", model: "local-large" },
    { id: "economy", provider: "openrouter", model: "openai/gpt-4o-mini" },
  ],
};

/** The same configuration, with one route's behaviour replaced by a fixture. */
function withTransport(modelId: string, behaviour: ProviderBehaviour) {
  const transport = fixtureTransport(behaviour);
  return { ...transport, modelId };
}

async function diagnose(modelId: string, behaviour: ProviderBehaviour) {
  const transport = withTransport(modelId, behaviour);
  const report = await diagnoseModel({
    configuration,
    modelId,
    fetch: transport.fetch,
  });
  return { report, captured: transport.captured };
}

describe("provider routes", () => {
  it("reaches each route at the endpoint its protocol expects", async () => {
    for (const [modelId, route] of [
      ["balanced", "openai"],
      ["thorough", "openai-compatible"],
      ["economy", "openrouter"],
    ] as const) {
      const { report, captured } = await diagnose(modelId, wellBehaved);
      expect(report.status).toBe("ready");
      const { toolCall, stream } = recordedRequests(route);
      // A diagnostic streams first and calls the tool second; each request is
      // matched to its recorded counterpart, so a change in either path is
      // caught here rather than by a provider in production.
      const streamed = captured.find((request) => request.body.stream === true);
      const called = captured.find((request) => request.body.tools !== undefined);
      expect(captured).toHaveLength(2);
      expect(streamed?.method).toBe(stream.method);
      expect(streamed?.url.endsWith(stream.url)).toBe(true);
      expect(called?.method).toBe(toolCall.method);
      expect(called?.url.endsWith(toolCall.url)).toBe(true);
      expect(called?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    }
  });

  it("sends the tool schema and demands the tool call, as recorded", async () => {
    const { captured } = await diagnose("balanced", wellBehaved);
    const { toolCall, stream } = recordedRequests("openai");
    const called = captured.find((request) => request.body.tools !== undefined);
    const streamed = captured.find((request) => request.body.stream === true);
    expect(called?.body.tools).toEqual(toolCall.body.tools);
    expect(called?.body.tool_choice).toEqual(toolCall.body.tool_choice);
    // The stream asks for token counts, which is what a call is charged on.
    expect(streamed?.body.stream_options).toEqual(stream.body.stream_options);
  });

  it("attributes OpenRouter traffic with the headers it asks for", async () => {
    const { captured } = await diagnose("economy", wellBehaved);
    expect(captured[0]?.headers["http-referer"]).toBe("http://localhost:3000");
    expect(captured[0]?.headers["x-title"]).toBe("shopping-assistant");
    // Without a stated endpoint, the route's own public one is used.
    const { toolCall } = recordedRequests("openrouter");
    expect(captured[0]?.url).toBe(`https://openrouter.ai${toolCall.url}`);
  });

  it("refuses to build a model whose provider has no credential", () => {
    const unkeyed: ModelConfiguration = {
      providers: [{ id: "openai", route: "openai" }],
      models: [{ id: "balanced", provider: "openai", model: "gpt-4o-mini" }],
    };
    expect(() => languageModelOf(unkeyed, "balanced")).toThrow(ModelConfigurationError);
    expect(providerReadiness({ id: "openai", route: "openai" }).ready).toBe(false);
  });

  it("refuses an OpenAI-compatible provider with no endpoint, since there is no default", () => {
    expect(() => endpointOf({ id: "compatible", route: "openai-compatible" })).toThrow(
      ModelConfigurationError,
    );
    expect(() =>
      languageModelOf(
        {
          providers: [{ id: "compatible", route: "openai-compatible", apiKey: API_KEY }],
          models: [{ id: "balanced", provider: "compatible", model: "local" }],
        },
        "balanced",
      ),
    ).toThrow(ModelConfigurationError);
  });

  it("refuses an id no provider stands behind, rather than choosing another", () => {
    expect(() => languageModelOf(configuration, "nonexistent")).toThrow(ModelConfigurationError);
  });
});

describe("capability diagnostics", () => {
  it("proves streaming and a typed tool call on every route", async () => {
    for (const modelId of ["balanced", "thorough", "economy"]) {
      const { report } = await diagnose(modelId, wellBehaved);
      expect(report.status).toBe("ready");
      expect(report.capabilities).toEqual({ streaming: "supported", toolCalling: "supported" });
      // Token counts come from the provider, so the charge is based on what was
      // actually used rather than on what was asked for.
      expect(report.usage.inputTokens).toBeGreaterThan(0);
      expect(report.usage.outputTokens).toBeGreaterThan(0);
    }
  });

  it("reports a provider that answers in one piece as not streaming", async () => {
    const { report } = await diagnose("balanced", notStreaming);
    expect(report.status).toBe("incompatible");
    expect(report.capabilities.streaming).toBe("unsupported");
    // Tool support is not exercised once streaming has failed, so it is not
    // claimed either way.
    expect(report.capabilities.toolCalling).toBe("not-exercised");
    expect(report.problem).toContain("without streaming");
  });

  it("reports a provider that ignores the declared tool", async () => {
    const { report } = await diagnose("thorough", toolIgnored);
    expect(report.status).toBe("incompatible");
    expect(report.capabilities).toEqual({ streaming: "supported", toolCalling: "unsupported" });
    expect(report.problem).toContain("without calling the declared tool");
  });

  it("reports a tool call whose arguments do not match the schema", async () => {
    const { report } = await diagnose("economy", toolMisTyped);
    expect(report.status).toBe("incompatible");
    expect(report.capabilities.toolCalling).toBe("unsupported");
    expect(report.problem).toContain("does not allow");
  });

  it("reports a rejected credential without repeating it", async () => {
    const { report } = await diagnose("balanced", credentialRejected);
    expect(report.status).toBe("failed");
    expect(report.capabilities.streaming).toBe("unsupported");
    expect(report.problem).toBe("the provider rejected the credential (401)");
    // The provider's own message echoed the key; it must not be relayed.
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });

  it("reports a rate limit and an unknown model as provider failures", async () => {
    const limited = await diagnose("balanced", rateLimited);
    expect(limited.report.status).toBe("failed");
    expect(limited.report.problem).toContain("429");

    const missing = await diagnose("balanced", unknownModel);
    expect(missing.report.status).toBe("failed");
    expect(missing.report.problem).toContain("404");
  });

  it("reports an endpoint that does not speak the route's protocol as incompatible", async () => {
    const { report } = await diagnose("thorough", wrongProtocol);
    expect(report.status).toBe("incompatible");
    expect(report.problem).toContain("protocol");
  });

  it("reports an unconfigured credential without making a call", async () => {
    const transport = fixtureTransport(wellBehaved);
    const report = await diagnoseModel({
      configuration: {
        providers: [{ id: "openai", route: "openai" }],
        models: [{ id: "balanced", provider: "openai", model: "gpt-4o-mini" }],
      },
      modelId: "balanced",
      fetch: transport.fetch,
    });
    expect(report.status).toBe("unconfigured");
    expect(report.capabilities).toEqual({
      streaming: "not-exercised",
      toolCalling: "not-exercised",
    });
    expect(transport.captured).toHaveLength(0);
  });

  it("refuses a model id the deployment has not configured", async () => {
    await expect(
      diagnoseModel({ configuration, modelId: "unconfigured", fetch: fixtureTransport(wellBehaved).fetch }),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });

  it("makes exactly one call per capability, so its cost is bounded", async () => {
    const { captured } = await diagnose("balanced", wellBehaved);
    expect(captured).toHaveLength(2);
    for (const request of captured) {
      // The output cap is sent, so a runaway answer cannot be billed.
      expect(request.body.max_tokens).toBe(64);
    }
  });

  it("never sends a credential anywhere but the provider's own header", async () => {
    const { report, captured } = await diagnose("economy", wellBehaved);
    for (const request of captured) {
      expect(request.url).not.toContain(API_KEY);
      expect(JSON.stringify(request.body)).not.toContain(API_KEY);
    }
    expect(JSON.stringify(report)).not.toContain(API_KEY);
  });
});
