// SPDX-License-Identifier: AGPL-3.0-or-later
import { generateText, jsonSchema, Output } from "ai";
import {
  REQUIRED_PRODUCT_FIELDS,
  type ModelExtractor,
  type ModelExtractorRequest,
  type ModelReading,
} from "@shopping/core";
import { languageModel } from "@/lib/models/ai-sdk-probe";

/**
 * Readable-content extraction through the pinned AI SDK (docs/adr/0012).
 *
 * Core decides what a page may contribute and whether a reading is supported;
 * this adapter only turns a readable page into one bounded, schema-constrained
 * model call. The schema requires the line index for every value, so a reading
 * that cannot point at the page is rejected by the SDK before core sees it.
 *
 * The same pinned packages as the capability probe are used, so a provider
 * protocol change cannot arrive unnoticed in one place and not the other.
 */
export const EXTRACTION_TIMEOUT_MS = 20_000;

/** The object the extraction call must return. */
interface ExtractionOutput {
  fields: Record<string, string>;
  evidence: Record<string, number>;
  attributes?: Record<string, string>;
}

const EXTRACTION_SCHEMA = jsonSchema<ExtractionOutput>({
  type: "object",
  properties: {
    fields: {
      type: "object",
      description: "Only the fields the page states; omit any the page does not state.",
      properties: Object.fromEntries(
        REQUIRED_PRODUCT_FIELDS.map((field) => [field, { type: "string" }]),
      ),
      additionalProperties: true,
    },
    evidence: {
      type: "object",
      description: "For each returned field, the index of the readable line it was read from.",
      properties: Object.fromEntries(
        REQUIRED_PRODUCT_FIELDS.map((field) => [field, { type: "integer", minimum: 0 }]),
      ),
      additionalProperties: { type: "integer", minimum: 0 },
    },
    attributes: {
      type: "object",
      description: "Specification names and values exactly as the page states them.",
      additionalProperties: { type: "string" },
    },
  },
  required: ["fields", "evidence"],
  additionalProperties: false,
});

/**
 * The extractor core asks for. A provider failure yields "no reading" rather
 * than a page failure: the page may be perfectly readable, and coverage then
 * honestly reports that the required fields were not found.
 */
export function createAiSdkExtractor(): ModelExtractor {
  return async (request: ModelExtractorRequest): Promise<ModelReading | null> => {
    const { model: resolved } = request;
    if (resolved.provider === "compatible" && !resolved.endpoint) return null;
    try {
      const result = await generateText({
        model: languageModel(resolved, resolved.apiKey),
        output: Output.object({ schema: EXTRACTION_SCHEMA }),
        prompt: request.prompt,
        maxOutputTokens: request.maxOutputTokens,
        // One call, no retries: the budget is charged per call, and an endpoint
        // that cannot answer must not multiply the spend.
        maxRetries: 0,
        timeout: EXTRACTION_TIMEOUT_MS,
      });
      const output = result.output;
      // The SDK validates the schema; an object whose required members are
      // absent is still not a reading, so it is refused here too.
      if (!output || typeof output.fields !== "object" || output.fields === null) return null;
      if (typeof output.evidence !== "object" || output.evidence === null) return null;
      return {
        fields: output.fields as ModelReading["fields"],
        evidence: output.evidence as ModelReading["evidence"],
        ...(output.attributes ? { attributes: output.attributes } : {}),
      };
    } catch {
      // A refusal or a schema violation is an observation about the endpoint,
      // not a crash: core records that nothing was extracted.
      return null;
    }
  };
}
