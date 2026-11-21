// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  migrateFresh, createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import type { Principal } from "../src/index";
import {
  createSourceCoverage,
  EXTRACTION_REVISION,
  type SourceCoverageService,
} from "../src/ingestion/source-coverage";
import { createSourceReader } from "../src/ingestion/source-reader";
import type { ModelExtractor } from "../src/ingestion/readable-extraction";
import {
  BOL_REDESIGNED_HTML,
  BOL_TABLE_HTML,
  COOLBLUE_JSONLD_HTML,
} from "./support/source-fixtures";

// Source coverage through the core against real PostgreSQL. What an operator
// needs is externally visible: adapter version, required-field coverage, last
// success and failure, fetch and cache times, access blocks — and the guarantee
// that a layout change never erases a good observation.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const readerPrincipal: Principal = {
  kind: "workspace",
  userId: "coverage-shopper",
  workspaceId: "coverage-workspace",
  sessionId: "coverage-session",
};
const anonymous: Principal = { kind: "anonymous" };
const COOLBLUE_URL = "https://www.coolblue.nl/product/869952/dell-ultrasharp-u2723qe.html";
const BOL_URL = "https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/";

const BOL_TEXT = `<html><body>
  <h1>Philips Airfryer Essential HD9200/90</h1>
  <p>Prijs: &euro; 79,99 (EUR)</p>
  <dl><dt>EAN</dt><dd>8710103926851</dd></dl>
</body></html>`;

describe("source coverage through the core", () => {
  let db: Knex;
  let service: SourceCoverageService;
  let clock: Date;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await migrateFresh(db);
  });

  beforeEach(async () => {
    await db("source_adapter_state").delete();
    await db("source_access_blocks").delete();
    await db("source_requests").delete();
    await db("source_claims").delete();
    await db("source_evidence").delete();
    clock = new Date("2026-11-19T10:00:00Z");
    service = createSourceCoverage({
      db,
      reader: createSourceReader({ db, now: () => clock, retrieve: async () => new Response("unused") }),
      now: () => clock,
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  async function persistReading(url: string, html: string) {
    const extraction = await service.extract({ url, html });
    await db("source_evidence").insert({ source_url: url, final_url: url, excerpt: html.slice(0, 2000), observed_at: clock });
    const [evidence] = await db("source_evidence").where({ source_url: url }).returning("id");
    const [product] = await db("products")
      .insert({ name: `coverage ${new URL(url).hostname}` })
      .returning("id");
    await db("source_claims").insert({
      evidence_id: evidence.id,
      product_id: product.id,
      field: "offer",
      value: JSON.stringify({ price: "559.00" }),
      observed_at: clock,
    });
    await service.recordReading({
      url,
      host: new URL(url).hostname,
      adapter: extraction.adapter,
      source: extraction.source,
      reading: extraction.reading,
      evidenceId: evidence.id as string,
      observedAt: clock,
    });
    return { extraction, evidenceId: evidence.id as string };
  }

  it("reports the maintained adapter, its version and complete required-field coverage", async () => {
    await persistReading(COOLBLUE_URL, COOLBLUE_JSONLD_HTML);

    const coverage = await service.read(anonymous, "www.coolblue.nl");

    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value).toMatchObject({
      host: "www.coolblue.nl",
      adapter: { id: "coolblue", version: "2026.11.1" },
      coverage: "complete",
      coveredFields: ["name", "price", "currency", "gtin"],
      missingFields: [],
      extraction: "source-adapter",
      lastSuccessAt: "2026-11-19T10:00:00.000Z",
      lastFailure: null,
    });
  });

  it("keeps a good observation when a layout change lowers coverage", async () => {
    const good = await persistReading(BOL_URL, BOL_TABLE_HTML);
    expect(good.extraction.reading.requiredCoverage.missing).toEqual([]);

    clock = new Date("2026-11-20T09:00:00Z");
    const redesign = await service.extract({ url: BOL_URL, html: BOL_REDESIGNED_HTML });
    await service.recordFailure({ url: BOL_URL, host: "www.bol.com", kind: "extraction-failed" });

    const coverage = await service.read(readerPrincipal, "www.bol.com");
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    // The failure is visible...
    expect(coverage.value.lastFailure).toEqual({ at: "2026-11-20T09:00:00.000Z", kind: "extraction-failed" });
    // ...but the earlier success and the evidence it produced are untouched.
    expect(coverage.value.lastSuccessAt).toBe("2026-11-19T10:00:00.000Z");
    expect(coverage.value.retained).toMatchObject({ evidenceId: good.evidenceId, claimCount: 1 });
    expect(coverage.value.coverage).toBe("complete");
    expect(redesign.refused).toBe(true);
    expect(redesign.reading.requiredCoverage.missing).toEqual(["price", "currency", "gtin"]);
  });

  it("records fetch, source cache and reuse times separately", async () => {
    const reader = createSourceReader({
      db,
      now: () => clock,
      sleep: async (ms) => {
        clock = new Date(clock.getTime() + ms);
      },
      retrieve: async () =>
        new Response(COOLBLUE_JSONLD_HTML, { status: 200, headers: { "cache-control": "max-age=900" } }),
    });
    const read = await reader.read(COOLBLUE_URL, service.cacheContext());
    expect(read.kind).toBe("read");
    const extraction = await service.extract({ url: COOLBLUE_URL, html: COOLBLUE_JSONLD_HTML });
    await service.recordReading({
      url: COOLBLUE_URL,
      host: "www.coolblue.nl",
      adapter: extraction.adapter,
      source: extraction.source,
      reading: extraction.reading,
      evidenceId: "00000000-0000-4000-8000-00000000aaaa",
      observedAt: clock,
    });

    const coverage = await createSourceCoverage({ db, reader, now: () => clock }).read(anonymous, "www.coolblue.nl");
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value.cache).toEqual({
      fetchedAt: "2026-11-19T10:00:00.000Z",
      sourceCacheExpiresAt: "2026-11-19T10:15:00.000Z",
      // The source said 900 s; reuse never outlives what the source allows.
      reuseExpiresAt: "2026-11-19T10:15:00.000Z",
    });
  });

  it("exposes recorded access blocks with the host's coverage", async () => {
    const reader = createSourceReader({
      db,
      now: () => clock,
      retrieve: async () => new Response("<html><h1>Even geduld, controleer of je een mens bent</h1></html>"),
    });
    await reader.read(BOL_URL, service.cacheContext());

    const coverage = await createSourceCoverage({ db, reader, now: () => clock }).read(anonymous, "www.bol.com");
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    expect(coverage.value.accessBlocks).toContainEqual(
      expect.objectContaining({ host: "www.bol.com", reason: "challenge", signal: "challenge-page" }),
    );
    // A blocked page produced no reading: coverage stays none.
    expect(coverage.value.coverage).toBe("none");
  });

  it("reports a host it has never read without inventing a success", async () => {
    const coverage = await service.read(anonymous, "www.example.nl");
    expect(coverage).toMatchObject({
      ok: true,
      value: {
        host: "www.example.nl",
        adapter: null,
        coverage: "none",
        lastSuccessAt: null,
        lastFailure: null,
        retained: { evidenceId: null, claimCount: 0 },
      },
    });
  });

  it("rejects a malformed host before touching storage", async () => {
    expect(await service.read(anonymous, "not a host")).toEqual({
      ok: false,
      error: { kind: "invalid-input", field: "host", message: "host must be a DNS hostname" },
    });
  });

  describe("readable content plus model extraction", () => {
    function withExtractor(extractor: ModelExtractor | undefined): SourceCoverageService {
      return createSourceCoverage({
        db,
        reader: createSourceReader({ db, now: () => clock, retrieve: async () => new Response("unused") }),
        ...(extractor
          ? {
              extractor,
              // Catalogue reading uses the installation's extraction model.
              resolveExtractionModel: async () => ({
                ok: true as const,
                value: {
                  provider: "compatible" as const,
                  modelId: "fixture-extraction",
                  endpoint: "http://127.0.0.1:1/v1",
                  role: "extraction" as const,
                  source: "installation" as const,
                  usageSource: "installation" as const,
                  apiKey: "fixture-key",
                },
              }),
            }
          : {}),
        now: () => clock,
      });
    }

    it("extracts a page with no structured data and no adapter, linked to its evidence", async () => {
      const extractor: ModelExtractor = async ({ content, sourceUrl, maxOutputTokens }) => {
        expect(sourceUrl).toBe("https://www.example.nl/airfryer");
        expect(maxOutputTokens).toBe(512);
        const lineOf = (text: string) => content.lines.findIndex((line) => line.text.includes(text));
        return {
          fields: {
            name: "Philips Airfryer Essential HD9200/90",
            price: "79.99",
            currency: "EUR",
            gtin: "8710103926851",
          },
          evidence: {
            name: lineOf("Philips Airfryer Essential"),
            price: lineOf("79,99"),
            currency: lineOf("EUR"),
            gtin: lineOf("8710103926851"),
          },
        };
      };

      const extraction = await withExtractor(extractor).extract({
        url: "https://www.example.nl/airfryer",
        html: BOL_TEXT,
      });

      expect(extraction).toMatchObject({
        source: "model",
        adapter: null,
        refused: false,
        reading: { requiredCoverage: { present: ["name", "price", "currency", "gtin"], missing: [] } },
      });
      expect(extraction.reading.evidence).toContainEqual({ field: "gtin", selector: "dd:contains", value: "8710103926851" });
    });

    it("refuses to invent a required field the page does not state", async () => {
      // The model answers a price from what it knows about the product. The
      // page never states it, so the answer is not recorded.
      const extractor: ModelExtractor = async ({ content }) => ({
        fields: { name: "Philips Airfryer Essential HD9200/90", price: "89.99", gtin: "8710103926851" },
        evidence: {
          name: content.lines.findIndex((line) => line.text.includes("Philips Airfryer Essential")),
          price: content.lines.findIndex((line) => line.text.includes("79,99")),
          gtin: content.lines.findIndex((line) => line.text.includes("8710103926851")),
        },
      });

      const extraction = await withExtractor(extractor).extract({
        url: "https://www.example.nl/airfryer",
        html: BOL_TEXT,
      });

      expect(extraction.reading.fields).toEqual({
        name: "Philips Airfryer Essential HD9200/90",
        gtin: "8710103926851",
      });
      expect(extraction.reading.requiredCoverage.missing).toEqual(["price", "currency"]);
      expect(extraction.refused).toBe(true);
    });

    it("does not call the model for a page it cannot read or when no model is configured", async () => {
      let called = 0;
      const extractor: ModelExtractor = async () => {
        called += 1;
        return null;
      };

      const blank = await withExtractor(extractor).extract({
        url: "https://www.example.nl/blank",
        html: "<html><body><script>app()</script></body></html>",
      });
      const unconfigured = await withExtractor(undefined).extract({
        url: "https://www.example.nl/airfryer",
        html: BOL_TEXT,
      });

      expect(called).toBe(0);
      expect(blank.refused).toBe(true);
      expect(unconfigured.refused).toBe(true);
      expect(unconfigured.reading.fields).toEqual({});
    });

    it("never asks the model to fill a gap a maintained adapter left", async () => {
      let called = 0;
      const extractor: ModelExtractor = async () => {
        called += 1;
        return { fields: { price: "79.99" }, evidence: { price: 0 } };
      };

      const extraction = await withExtractor(extractor).extract({ url: BOL_URL, html: BOL_REDESIGNED_HTML });

      expect(called).toBe(0);
      expect(extraction.source).toBe("source-adapter");
      expect(extraction.adapter).toEqual({ id: "bol", version: "2026.11.1" });
      expect(extraction.reading.requiredCoverage.missing).toEqual(["price", "currency", "gtin"]);
    });
  });

  it("isolates the cache context by extraction revision", () => {
    expect(service.cacheContext()).toEqual({ scope: "public-catalogue", revision: EXTRACTION_REVISION });
  });
});
