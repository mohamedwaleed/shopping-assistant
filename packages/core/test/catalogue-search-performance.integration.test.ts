// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { createShoppingCore, createSecretCipher, type Principal } from "../src/index";

// Representative PostgreSQL performance for catalogue search: the planner must
// choose the full-text and trigram indexes over sequential scans, and a search
// over a catalogue of a realistic size must answer within a bounded time. This
// runs against real PostgreSQL; there is no in-memory stand-in for a planner.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const anonymous: Principal = { kind: "anonymous" };
const CATALOGUE_SIZE = 1_500;
const BUDGET_MS = 2_000;

function productIds(): string[] {
  return Array.from(
    { length: CATALOGUE_SIZE },
    (_, index) => `c0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
}

describe("catalogue search query performance", () => {
  let db: Knex;
  let core: ReturnType<typeof createShoppingCore>;
  let ids: string[];

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    core = createShoppingCore({
      db,
      models: {
        cipher: createSecretCipher({ key: "search-performance-installation-secret" }),
        probe: async () => {
          throw new Error("search never probes a model");
        },
      },
    });

    ids = productIds();
    const products = ids.map((id, index) => ({
      id,
      name: `Bulk Product ${index} Monitor`,
      manufacturer: `Manufacturer ${index % 40}`,
      category: index % 3 === 0 ? "monitors" : "kitchen",
    }));
    const variants = ids.map((id, index) => ({
      id: `c1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      product_id: id,
      name: `Bulk Product ${index} ${index % 2 === 0 ? "Monitor" : "Waterkoker"}`,
      gtin: `87${String(index).padStart(11, "0")}`,
      manufacturer_part_number: `BULK-${index}`,
      attributes: {
        colour: index % 4 === 0 ? "black" : "white",
        power_w: 50 + (index % 30) * 10,
      },
    }));
    for (let offset = 0; offset < products.length; offset += 500) {
      await db("products").insert(products.slice(offset, offset + 500));
      await db("variants").insert(variants.slice(offset, offset + 500));
    }
    // Plans are only meaningful once statistics describe the real table.
    await db.raw("ANALYZE variants");
    await db.raw("ANALYZE variant_search_documents");
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("keeps the retrieval indexes the search depends on", async () => {
    const indexes = await db.raw(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
    );
    const names = new Set(indexes.rows.map((row: { indexname: string }) => row.indexname));
    for (const expected of [
      "variant_search_documents_document_idx",
      "variants_mpn_trgm_idx",
      "variants_gtin_trgm_idx",
      "variants_name_trgm_idx",
      "catalogue_search_vocabulary_terms_term_trgm_idx",
    ]) {
      expect(names.has(expected), expected).toBe(true);
    }
  });

  it(`answers an identifier, a filter and a text search within ${BUDGET_MS} ms over ${CATALOGUE_SIZE} variants`, async () => {
    const timed = async (label: string, run: () => Promise<{ ok: boolean }>) => {
      const started = performance.now();
      const result = await run();
      const elapsed = performance.now() - started;
      expect(result.ok, label).toBe(true);
      expect(elapsed, `${label} took ${Math.round(elapsed)} ms`).toBeLessThan(BUDGET_MS);
    };

    await timed("identifier", () => core.catalogue.search(anonymous, { identifiers: "BULK-1499" }));
    await timed("filter", () =>
      core.catalogue.search(anonymous, {
        filters: [{ key: "power_w", op: "gte", value: "300" }],
        limit: 10,
      }),
    );
    await timed("text", () => core.catalogue.search(anonymous, { text: "monitor zwart" }));

    const text = await core.catalogue.search(anonymous, { text: "monitor zwart" });
    expect(text.ok && text.value.results.length).toBeGreaterThan(0);
  });
});
