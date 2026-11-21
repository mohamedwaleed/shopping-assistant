// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  migrateFresh, createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createSourceCoverage,
  createSourceReader,
  extractionPrompt,
  readableContent,
  REQUIRED_PRODUCT_FIELDS,
  type ModelTarget,
  type ResolvedModel,
} from "@shopping/core";
import { createAiSdkExtractor, EXTRACTION_TIMEOUT_MS } from "@/lib/models/ai-sdk-extraction";
import { startProviderFixtures, structuredRequests, type ProviderFixture } from "./support/provider-fixtures";

// The AI SDK extraction adapter is the seam where a readable page becomes a
// model call. It runs against the loopback provider fixtures, so no network or
// real key is involved, and its output is then put through core's verification
// to prove the end-to-end path: model answer -> evidence-linked reading.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const KEY = "fixture-extraction-key-0001";

const READABLE_PAGE = `<html><body>
  <h1>Philips Airfryer Essential HD9200/90</h1>
  <p>De Philips Airfryer Essential bakt in een keer.</p>
  <p>Prijs: &euro; 79,99 (EUR)</p>
  <dl><dt>EAN</dt><dd>8710103926851</dd><dt>Model</dt><dd>HD9200/90</dd></dl>
</body></html>`;

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

function resolved(modelId: string, provider: "openai" | "anthropic" | "compatible" = "openai"): ResolvedModel {
  const endpoint =
    provider === "openai"
      ? `${fixtures.baseUrl}/openai/v1`
      : provider === "anthropic"
        ? `${fixtures.baseUrl}/anthropic/v1`
        : `${fixtures.baseUrl}/compatible/v1`;
  const target: ModelTarget = { provider, modelId, endpoint };
  return {
    ...target,
    role: "extraction",
    source: "installation",
    usageSource: "installation",
    apiKey: KEY,
  };
}

function request(modelId: string, provider: "openai" | "anthropic" | "compatible" = "openai") {
  const content = readableContent(READABLE_PAGE);
  return {
    content,
    sourceUrl: "https://www.example.nl/airfryer",
    maxOutputTokens: 512,
    prompt: extractionPrompt(content, "https://www.example.nl/airfryer"),
    model: resolved(modelId, provider),
  };
}

describe("AI SDK extraction adapter", () => {
  it("returns an evidence-linked reading for each pinned provider protocol", async () => {
    const extractor = createAiSdkExtractor();

    for (const provider of ["openai", "anthropic", "compatible"] as const) {
      fixtures.reset();
      const reading = await extractor(request("fixture-model-complete", provider));

      expect(reading).toEqual({
        fields: {
          name: "Philips Airfryer Essential HD9200/90",
          price: "79.99",
          currency: "EUR",
          gtin: "8710103926851",
        },
        evidence: { name: 0, price: 2, currency: 2, gtin: 4 },
        attributes: { Model: "HD9200/90" },
      });
      // One call, and the schema travelled in that provider's own protocol.
      expect(fixtures.requests).toHaveLength(1);
      expect(structuredRequests(fixtures.requests)).toHaveLength(1);
      // The credential travelled in a header only.
      expect(JSON.stringify(fixtures.requests.map((entry) => entry.body))).not.toContain(KEY);
    }
  });

  it("asks for no more output tokens than the bound and makes exactly one call", async () => {
    await createAiSdkExtractor()(request("fixture-model-complete"));
    const requested = fixtures.requests.map(
      (entry) => entry.body.max_tokens ?? entry.body.max_output_tokens,
    );
    expect(requested).toEqual([512]);
  });

  it("returns no reading when the endpoint answers prose or the wrong shape", async () => {
    const extractor = createAiSdkExtractor();

    expect(await extractor(request("fixture-model-no-structured"))).toBeNull();
    fixtures.reset();
    expect(await extractor(request("fixture-model-json-prose"))).toBeNull();
  });

  it("returns no reading when the endpoint refuses the credential or is unreachable", async () => {
    const extractor = createAiSdkExtractor();

    expect(await extractor(request("fixture-model-unauthorized"))).toBeNull();
    fixtures.reset();
    expect(await extractor(request("fixture-model-unreachable"))).toBeNull();
    // No SDK retries: a refused call is not repeated.
    expect(fixtures.requests.length).toBeLessThanOrEqual(1);
  });

  it("refuses a compatible model without an endpoint before calling anything", async () => {
    const base = request("fixture-model-complete", "compatible");
    const { endpoint: _endpoint, ...withoutEndpoint } = base.model;
    expect(await createAiSdkExtractor()({ ...base, model: withoutEndpoint })).toBeNull();
    expect(fixtures.requests).toEqual([]);
  });

  it("documents the single-call timeout the adapter enforces", () => {
    expect(EXTRACTION_TIMEOUT_MS).toBe(20_000);
  });
});

describe("model extraction through the core", () => {
  let db: Knex;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await migrateFresh(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  function service() {
    return createSourceCoverage({
      db,
      reader: createSourceReader({ db, retrieve: async () => new Response("unused") }),
      extractor: createAiSdkExtractor(),
      resolveExtractionModel: async () => ({ ok: true, value: resolved("fixture-model-complete") }),
    });
  }

  it("turns a fixture model answer into a verified, complete reading", async () => {
    const extraction = await service().extract({
      url: "https://www.example.nl/airfryer",
      html: READABLE_PAGE,
    });

    expect(extraction.source).toBe("model");
    expect(extraction.refused).toBe(false);
    expect(extraction.reading.fields).toEqual({
      name: "Philips Airfryer Essential HD9200/90",
      price: "79.99",
      currency: "EUR",
      gtin: "8710103926851",
    });
    expect(extraction.reading.requiredCoverage.present).toEqual([...REQUIRED_PRODUCT_FIELDS]);
    expect(extraction.reading.evidence).toContainEqual({
      field: "price",
      selector: "p:contains",
      value: "79.99",
    });
  });

  it("records nothing when the model endpoint cannot honour the schema", async () => {
    const unhelpful = createSourceCoverage({
      db,
      reader: createSourceReader({ db, retrieve: async () => new Response("unused") }),
      extractor: createAiSdkExtractor(),
      resolveExtractionModel: async () => ({
        ok: true,
        value: resolved("fixture-model-no-structured"),
      }),
    });

    const extraction = await unhelpful.extract({
      url: "https://www.example.nl/airfryer",
      html: READABLE_PAGE,
    });

    expect(extraction.refused).toBe(true);
    expect(extraction.reading.fields).toEqual({});
    expect(extraction.reading.requiredCoverage.missing).toEqual([...REQUIRED_PRODUCT_FIELDS]);
  });

  it("records nothing when no extraction model is configured", async () => {
    const unconfigured = createSourceCoverage({
      db,
      reader: createSourceReader({ db, retrieve: async () => new Response("unused") }),
      extractor: createAiSdkExtractor(),
      resolveExtractionModel: async () => ({ ok: false, error: { kind: "model-not-configured", role: "extraction" } }),
    });

    fixtures.reset();
    const extraction = await unconfigured.extract({
      url: "https://www.example.nl/airfryer",
      html: READABLE_PAGE,
    });

    expect(extraction.refused).toBe(true);
    expect(fixtures.requests).toEqual([]);
  });
});
