import { describe, expect, it } from "vitest";
import { loadModelConfiguration, modelConfigurationFromEnvironment } from "./environment.ts";
import { ModelConfigurationError } from "./providers.ts";
import { LIVE_CHECK_VARIABLE, liveCheck, liveCheckEnabled } from "./live-check.ts";

const environment = {
  MODEL_OPENAI_API_KEY: "sk-openai-fixture",
  MODEL_COMPATIBLE_BASE_URL: "https://llm.example.com/v1",
  MODEL_OPENROUTER_API_KEY: "sk-openrouter-fixture",
  MODEL_OPENROUTER_BASE_URL: "https://openrouter.example.com/api/v1",
  MODEL_SITE_URL: "http://localhost:3000",
  MODEL_APP_NAME: "shopping-assistant",
  MODEL_BALANCED: "openai:gpt-4o-mini",
  MODEL_THOROUGH: "compatible:local-large",
  MODEL_ECONOMY: "openrouter:openai/gpt-4o-mini",
} satisfies NodeJS.ProcessEnv;

describe("model configuration from the environment", () => {
  it("reads all three routes and the model each offered id is reached through", () => {
    const configuration = loadModelConfiguration(environment);
    expect(configuration.providers.map((provider) => provider.route)).toEqual([
      "openai",
      "openai-compatible",
      "openrouter",
    ]);
    expect(configuration.models).toEqual([
      { id: "balanced", provider: "openai", model: "gpt-4o-mini" },
      { id: "thorough", provider: "compatible", model: "local-large" },
      { id: "economy", provider: "openrouter", model: "openai/gpt-4o-mini" },
    ]);
  });

  it("carries the attribution OpenRouter asks for", () => {
    const openrouter = loadModelConfiguration(environment).providers.find(
      (provider) => provider.route === "openrouter",
    );
    expect(openrouter?.attribution).toEqual({
      siteUrl: "http://localhost:3000",
      appName: "shopping-assistant",
    });
  });

  it("leaves an absent route out rather than inventing one", () => {
    const configuration = loadModelConfiguration({
      MODEL_OPENAI_API_KEY: "sk-openai-fixture",
      MODEL_BALANCED: "openai:gpt-4o-mini",
    });
    expect(configuration.providers).toHaveLength(1);
    expect(configuration.models).toHaveLength(1);
  });

  it("refuses a model that names a provider the deployment does not have", () => {
    expect(() =>
      modelConfigurationFromEnvironment({
        MODEL_OPENAI_API_KEY: "sk-openai-fixture",
        MODEL_BALANCED: "openrouter:openai/gpt-4o-mini",
      }),
    ).toThrow(ModelConfigurationError);
  });

  it("keeps unrelated variables out of the model listing", () => {
    const configuration = loadModelConfiguration({
      MODEL_OPENAI_API_KEY: "sk-openai-fixture",
      MODEL_SITE_URL: "http://localhost:3000",
      MODEL_APP_NAME: "shopping-assistant",
      MODEL_BALANCED: "openai:gpt-4o-mini",
      UNRELATED: "ignored",
    });
    // The credentials and the attribution share the prefix; only a
    // `route:model` listing is a model.
    expect(configuration.models).toEqual([
      { id: "balanced", provider: "openai", model: "gpt-4o-mini" },
    ]);
  });

  it("refuses a model listing with no model name", () => {
    expect(() =>
      loadModelConfiguration({
        MODEL_OPENAI_API_KEY: "sk-openai-fixture",
        MODEL_BALANCED: "openai:",
      }),
    ).toThrow(ModelConfigurationError);
  });
});

describe("live check", () => {
  it("is skipped unless it is asked for explicitly", async () => {
    expect(liveCheckEnabled({})).toBe(false);
    const result = await liveCheck({
      configuration: loadModelConfiguration(environment),
      environment: {},
    });
    expect(result.skipped).toBe(true);
    // A skipped check never contacted a provider, and says so rather than
    // looking like a passing one.
    expect(result.reason).toContain(LIVE_CHECK_VARIABLE);
    expect(result.reports).toEqual([]);
  });

  it("is turned on only by an explicit value", () => {
    expect(liveCheckEnabled({ [LIVE_CHECK_VARIABLE]: "1" })).toBe(true);
    expect(liveCheckEnabled({ [LIVE_CHECK_VARIABLE]: "true" })).toBe(true);
    expect(liveCheckEnabled({ [LIVE_CHECK_VARIABLE]: "0" })).toBe(false);
    expect(liveCheckEnabled({ [LIVE_CHECK_VARIABLE]: "yes" })).toBe(false);
  });
});
