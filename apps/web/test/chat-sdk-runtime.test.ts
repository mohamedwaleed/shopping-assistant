// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { languageModel } from "@/lib/models/ai-sdk-probe";
import { startProviderFixtures, type ProviderFixture } from "./support/provider-fixtures";

describe("shopping chat through the pinned AI SDK runtime", () => {
  let fixture: ProviderFixture;
  beforeAll(async () => { fixture = await startProviderFixtures(); });
  afterAll(async () => { await fixture?.close(); });

  it("streams a typed requirements tool result rather than a mocked transcript", async () => {
    let saved: unknown;
    const result = streamText({
      model: languageModel({ provider: "compatible", modelId: "fixture-model-complete", endpoint: `${fixture.baseUrl}/compatible/v1` }, "fixture-secret"),
      prompt: "Call the requirements_update tool for this shopping request.",
      stopWhen: stepCountIs(2),
      tools: { requirements_update: tool({ description: "Save requirements", inputSchema: jsonSchema<{ mustHaves: string[]; preferences: string[]; assumptions: string[]; questions: string[]; revisionNote: string }>({ type: "object", properties: { mustHaves: { type: "array", items: { type: "string" } }, preferences: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } }, questions: { type: "array", items: { type: "string" } }, revisionNote: { type: "string" } }, required: ["mustHaves", "preferences", "assumptions", "questions", "revisionNote"] }), execute: async (input) => { saved = input; return input; } }) },
    });
    await expect(result.text).resolves.toBe("");
    expect(saved).toMatchObject({ mustHaves: ["under €1000"], questions: ["What screen size?"] });
    expect(fixture.requests.some((request) => request.body.stream === true)).toBe(true);
    expect(JSON.stringify(fixture.requests.map((request) => request.body))).not.toContain("fixture-secret");
  });

  it("surfaces malformed model output and provider failures", async () => {
    const malformed = streamText({ model: languageModel({ provider: "compatible", modelId: "fixture-model-unauthorized", endpoint: `${fixture.baseUrl}/compatible/v1` }, "fixture-secret"), prompt: "hello" });
    await expect(malformed.text).rejects.toThrow();
  });
});
