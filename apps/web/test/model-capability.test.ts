// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityReport } from "@shopping/core";
import {
  createAiSdkProbe,
  MODEL_ADAPTER_PINS,
} from "@/lib/models/ai-sdk-probe";
import {
  credentialsSeen,
  startProviderFixtures,
  structuredRequests,
  type ProviderFixture,
} from "./support/provider-fixtures";

// The AI SDK adapter is the seam where a configured endpoint becomes real SDK
// calls. Every check runs against a deterministic loopback fixture that speaks
// the providers' wire protocols, so no network or real key is involved.
const OPENAI_KEY = "sk-fixture-openai-key-0001";
const ANTHROPIC_KEY = "sk-ant-fixture-key-0001";
const LOCAL_KEY = "fixture-local-key-0001";

const BOUNDS = { maxCalls: 4, maxOutputTokens: 32 };

let fixtures: ProviderFixture;
let probe: ReturnType<typeof createAiSdkProbe>;

type ProbeTarget =
  | ReturnType<typeof openAiTarget>
  | ReturnType<typeof anthropicTarget>
  | ReturnType<typeof compatibleTarget>;

/** A refused probe is a typed error, not a thrown exception (defect 4). */
function expectReport(result: Awaited<ReturnType<ReturnType<typeof createAiSdkProbe>>>): CapabilityReport {
  if (!result.ok) throw new Error(`probe refused: ${result.error.kind}`);
  return result.value;
}

/** The provider a fixture key belongs to; the adapter refuses a mismatch. */
async function probeWith(
  target: ProbeTarget,
  apiKey: string,
  bounds = BOUNDS,
): Promise<CapabilityReport> {
  return expectReport(await probe({ target, provider: target.provider, apiKey, bounds }));
}

beforeAll(async () => {
  fixtures = await startProviderFixtures();
});

beforeEach(() => {
  fixtures.reset();
  probe = createAiSdkProbe();
});

afterAll(async () => {
  await fixtures.close();
});

function openAiTarget(modelId = "fixture-model-complete") {
  return {
    provider: "openai" as const,
    modelId,
    endpoint: `${fixtures.baseUrl}/openai/v1`,
  };
}

function anthropicTarget(modelId = "fixture-model-complete") {
  return {
    provider: "anthropic" as const,
    modelId,
    endpoint: `${fixtures.baseUrl}/anthropic/v1`,
  };
}

function compatibleTarget(modelId = "fixture-model-complete") {
  return {
    provider: "compatible" as const,
    modelId,
    endpoint: `${fixtures.baseUrl}/compatible/v1`,
  };
}

describe("pinned provider adapters", () => {
  it("documents the pinned AI SDK packages the adapter builds on", () => {
    expect(MODEL_ADAPTER_PINS).toEqual({
      ai: "7.0.172",
      openai: "@ai-sdk/openai@4.0.118",
      anthropic: "@ai-sdk/anthropic@4.0.105",
      compatible: "@ai-sdk/openai-compatible@3.0.92",
    });
  });
});

describe("OpenAI API-key adapter", () => {
  it("proves text, typed tools, structured output and streaming through the SDK", async () => {
    const report = await probeWith(openAiTarget(), OPENAI_KEY, BOUNDS);

    expect(report).toMatchObject({
      provider: "openai",
      modelId: "fixture-model-complete",
      bounds: BOUNDS,
      capabilities: {
        text: "supported",
        tools: "supported",
        structuredOutput: "supported",
        streaming: "supported",
      },
    });
    expect(report.error).toBeUndefined();

    // Structured output is proven against a schema the SDK sent, not against a
    // prompt that merely asked for JSON.
    expect(structuredRequests(fixtures.requests)).toEqual(["json-schema"]);

    // The credential travelled in the Authorization header only, never the body.
    expect(fixtures.requests.length).toBeGreaterThan(0);
    expect(fixtures.requests.every((request) => request.authorization === `Bearer ${OPENAI_KEY}`)).toBe(true);
    expect(JSON.stringify(fixtures.requests.map((request) => request.body))).not.toContain(OPENAI_KEY);
    expect(report).not.toHaveProperty("apiKey");
  });
});

describe("Anthropic API-key adapter", () => {
  it("proves the same capabilities with the Anthropic message protocol", async () => {
    const report = await probeWith(anthropicTarget(), ANTHROPIC_KEY, BOUNDS);

    expect(report.capabilities).toEqual({
      text: "supported",
      tools: "supported",
      structuredOutput: "supported",
      streaming: "supported",
    });
    expect(fixtures.requests.every((request) => request.path === "/anthropic/v1/messages")).toBe(true);
    expect(fixtures.requests.every((request) => request.apiKey === ANTHROPIC_KEY)).toBe(true);
    expect(JSON.stringify(fixtures.requests.map((request) => request.body))).not.toContain(ANTHROPIC_KEY);
    // Forced `json` tool with the probe schema: the reply was constrained.
    expect(structuredRequests(fixtures.requests)).toEqual(["json-schema"]);
  });
});

describe("compatible or local endpoint", () => {
  it("records which capabilities the endpoint actually supports", async () => {
    const report = await probeWith(compatibleTarget("fixture-model-complete"), LOCAL_KEY, BOUNDS);
    expect(report.capabilities).toEqual({
      text: "supported",
      tools: "supported",
      structuredOutput: "supported",
      streaming: "supported",
    });
    expect(fixtures.requests.every((request) => request.path === "/compatible/v1/chat/completions")).toBe(true);
    // The openai-compatible provider defaults to JSON mode, which is still a
    // response format the endpoint has to honour.
    expect(structuredRequests(fixtures.requests)).toEqual(["json-mode"]);
  });

  it("does not trust a compatibility label when tools are ignored", async () => {
    const report = await probeWith(compatibleTarget("fixture-model-no-tools"), LOCAL_KEY, BOUNDS);
    expect(report.capabilities).toMatchObject({ text: "supported", tools: "unsupported" });
    expect(report.error).toBeUndefined();
  });

  it("does not trust a compatibility label when structured output is not honoured", async () => {
    const report = await probeWith(compatibleTarget("fixture-model-no-structured"), LOCAL_KEY, BOUNDS);
    expect(report.capabilities).toMatchObject({
      text: "supported",
      structuredOutput: "unsupported",
      streaming: "supported",
    });
  });

  it("does not accept JSON-shaped prose in place of the requested schema", async () => {
    // The fixture answers valid JSON of the wrong shape: the old JSON.parse
    // check would have recorded this as supported.
    const report = await probeWith(compatibleTarget("fixture-model-json-prose"), LOCAL_KEY, BOUNDS);
    expect(report.capabilities).toMatchObject({
      text: "supported",
      structuredOutput: "unsupported",
      streaming: "supported",
    });
    // A schema violation is an observation, not a failed diagnostic.
    expect(report.error).toBeUndefined();
  });

  it("does not trust a compatibility label when the endpoint cannot stream", async () => {
    const report = await probeWith(compatibleTarget("fixture-model-no-streaming"), LOCAL_KEY, BOUNDS);
    expect(report.capabilities).toMatchObject({ streaming: "unsupported", text: "supported" });
  });
});

describe("diagnostic bounds and failures", () => {
  it("never makes more calls than the call bound allows", async () => {
    const report = await probeWith(compatibleTarget(), LOCAL_KEY, { maxCalls: 2, maxOutputTokens: 16 });
    expect(fixtures.requests.length).toBeLessThanOrEqual(2);
    // Capabilities that were not exercised are unsupported, never assumed.
    expect(report.capabilities).toMatchObject({ text: "supported", tools: "supported" });
    expect(report.bounds).toEqual({ maxCalls: 2, maxOutputTokens: 16 });
  });

  it("asks for no more output tokens than the token bound", async () => {
    await probeWith(compatibleTarget(), LOCAL_KEY, { maxCalls: 4, maxOutputTokens: 7 });
    const requested = fixtures.requests.map((request) => request.body.max_tokens ?? request.body.max_output_tokens);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((tokens) => tokens === 7)).toBe(true);
  });

  it("disables SDK retries so a diagnostic stays within its call bound", async () => {
    const report = await probeWith(compatibleTarget("fixture-model-unauthorized"), LOCAL_KEY, BOUNDS);
    expect(report.capabilities).toMatchObject({ text: "unsupported", tools: "unsupported" });
    expect(report.error).toEqual({ kind: "provider-unavailable", message: expect.any(String) });
    // One attempt per check step: no SDK retries doubling the spend.
    expect(fixtures.requests.length).toBeLessThanOrEqual(BOUNDS.maxCalls);
    expect(report.error?.message).not.toContain(LOCAL_KEY);
  });

  it("reports an unreachable endpoint without throwing or leaking the key", async () => {
    const report = await probeWith(compatibleTarget("fixture-model-unreachable"), LOCAL_KEY, BOUNDS);
    expect(report.error?.kind).toBe("provider-unavailable");
    expect(JSON.stringify(report)).not.toContain(LOCAL_KEY);
  });

  it("refuses a credential that belongs to another provider as a typed error", async () => {
    const result = await probe({
      target: openAiTarget(),
      provider: "anthropic",
      apiKey: ANTHROPIC_KEY,
      bounds: BOUNDS,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "model-credential-provider-mismatch",
        provider: "openai",
        credentialProvider: "anthropic",
        source: "probe",
      },
    });
    // Nothing was sent: the key never left the process.
    expect(fixtures.requests).toEqual([]);
  });

  it("refuses a compatible endpoint without a base URL as a typed error", async () => {
    const result = await probe({
      target: { provider: "compatible", modelId: "fixture-model-complete" },
      provider: "compatible",
      apiKey: LOCAL_KEY,
      bounds: BOUNDS,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "endpoint",
        message: "a compatible endpoint requires a base URL",
      },
    });
    expect(fixtures.requests).toEqual([]);
  });

  it("sends credentials only to the configured endpoint", async () => {
    await probeWith(compatibleTarget(), LOCAL_KEY, BOUNDS);
    expect(credentialsSeen(fixtures.requests)).toEqual(
      fixtures.requests.map(() => LOCAL_KEY),
    );
  });
});
