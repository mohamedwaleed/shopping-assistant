// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  createDb,
  DEFAULT_TEST_DATABASE_URL,
  DEVELOPMENT_FIXTURE_IDS,
  loadDevelopmentFixtures,
} from "@shopping/db";
import { createShoppingCore, createSecretCipher, type Principal } from "../src/index";

// Search is a core operation: the tests below exercise the engine against real
// PostgreSQL (full-text + pg_trgm), never a fake, and read the same surface the
// HTTP adapter exposes.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const anonymous: Principal = { kind: "anonymous" };

// Fixed-UUID rows owned by this test file. They are deliberately NOT the
// development fixtures: fixtures prove the shape, these prove behaviour.
const IDS = {
  monitorProduct: "b0000000-0000-4000-8000-000000000001",
  kettleProduct: "b0000000-0000-4000-8000-000000000002",
  fridgeProduct: "b0000000-0000-4000-8000-000000000003",
  retailer: "b0000000-0000-4000-8000-000000000010",
  blackMonitor: "b0000000-0000-4000-8000-000000000021",
  whiteMonitor: "b0000000-0000-4000-8000-000000000022",
  greyMonitorUnknownColour: "b0000000-0000-4000-8000-000000000023",
  kettle: "b0000000-0000-4000-8000-000000000024",
  fridge: "b0000000-0000-4000-8000-000000000025",
  blackMonitorOffer: "b0000000-0000-4000-8000-000000000031",
  kettleOffer: "b0000000-0000-4000-8000-000000000032",
  blackMonitorObservation: "b0000000-0000-4000-8000-000000000041",
  kettleObservation: "b0000000-0000-4000-8000-000000000042",
  blackMonitorEvidence: "b0000000-0000-4000-8000-000000000051",
  greyMonitorEvidence: "b0000000-0000-4000-8000-000000000052",
} as const;

const SEARCH_OBSERVED_AT = new Date("2026-11-18T09:30:00Z");

async function seedSearchCatalogue(db: Knex): Promise<void> {
  await db("products").insert([
    {
      id: IDS.monitorProduct,
      name: "Vantage Pro 27 Monitor",
      manufacturer: "Vantage",
      category: "monitors",
      is_development_fixture: false,
    },
    {
      id: IDS.kettleProduct,
      name: "Huismerk Waterkoker 1.7L",
      manufacturer: "Huismerk",
      category: "kitchen",
      is_development_fixture: false,
    },
    {
      id: IDS.fridgeProduct,
      name: "Koelbox Compact Fridge",
      manufacturer: "Koelbox",
      category: "kitchen",
      is_development_fixture: false,
    },
  ]);
  await db("retailers").insert({
    id: IDS.retailer,
    name: "Voorbeeldwinkel",
    base_url: "https://voorbeeldwinkel.example.test",
  });
  await db("variants").insert([
    {
      id: IDS.blackMonitor,
      product_id: IDS.monitorProduct,
      name: "Vantage Pro 27 4K USB-C monitor",
      gtin: "8710000000017",
      manufacturer_part_number: "VP27-BLK",
      attributes: { colour: "black", screen_size_inch: 27, power_w: 90 },
    },
    {
      id: IDS.whiteMonitor,
      product_id: IDS.monitorProduct,
      name: "Vantage Pro 27 4K USB-C monitor",
      gtin: "8710000000024",
      manufacturer_part_number: "VP27-WHT",
      attributes: { colour: "white", screen_size_inch: 27, power_w: 90 },
    },
    {
      // A colour claim exists but was never accepted, so the canonical
      // attribute is absent: the variant must not match a colour filter.
      id: IDS.greyMonitorUnknownColour,
      product_id: IDS.monitorProduct,
      name: "Vantage Pro 24 QHD monitor",
      gtin: "8710000000031",
      manufacturer_part_number: "VP24-GRY",
      attributes: { screen_size_inch: 24, power_w: 65 },
    },
    {
      id: IDS.kettle,
      product_id: IDS.kettleProduct,
      name: "Huismerk Waterkoker 1.7L RVS",
      gtin: "8720000000015",
      manufacturer_part_number: "HM-WK17",
      attributes: { power_w: 1800, colour: "black" },
    },
    {
      id: IDS.fridge,
      product_id: IDS.fridgeProduct,
      name: "Koelbox Compact 90L",
      gtin: "8730000000012",
      manufacturer_part_number: "KB-C90",
      attributes: { power_w: 120 },
    },
  ]);
  await db("offers").insert([
    {
      id: IDS.blackMonitorOffer,
      variant_id: IDS.blackMonitor,
      retailer_id: IDS.retailer,
      url: "https://voorbeeldwinkel.example.test/vantage-pro-27-zwart",
      condition: "new",
    },
    {
      id: IDS.kettleOffer,
      variant_id: IDS.kettle,
      retailer_id: IDS.retailer,
      url: "https://voorbeeldwinkel.example.test/huismerk-waterkoker",
      condition: "new",
    },
  ]);
  await db("price_observations").insert([
    {
      id: IDS.blackMonitorObservation,
      offer_id: IDS.blackMonitorOffer,
      amount: "349.00",
      currency: "EUR",
      shipping_amount: "0.00",
      vat_included: true,
      source_kind: "retailer_page",
      observed_at: SEARCH_OBSERVED_AT,
    },
    {
      id: IDS.kettleObservation,
      offer_id: IDS.kettleOffer,
      amount: "39.95",
      currency: "EUR",
      shipping_amount: "4.95",
      vat_included: true,
      source_kind: "retailer_page",
      observed_at: SEARCH_OBSERVED_AT,
    },
  ]);
  await db("source_evidence").insert([
    {
      id: IDS.blackMonitorEvidence,
      source_url: "https://voorbeeldwinkel.example.test/vantage-pro-27-zwart",
      final_url: "https://voorbeeldwinkel.example.test/vantage-pro-27-zwart",
      excerpt: "Vantage Pro 27 4K USB-C monitor, kleur zwart, 90 watt",
      observed_at: SEARCH_OBSERVED_AT,
    },
    {
      id: IDS.greyMonitorEvidence,
      source_url: "https://voorbeeldwinkel.example.test/vantage-pro-24",
      final_url: "https://voorbeeldwinkel.example.test/vantage-pro-24",
      excerpt: "Vantage Pro 24 QHD monitor, kleur grijs",
      observed_at: SEARCH_OBSERVED_AT,
    },
  ]);
  // The black monitor's colour was reviewed and accepted: it is verified.
  const colourAttribute = await db("catalogue_attributes").where({ key: "colour" }).first();
  await db("source_claims").insert([
    {
      evidence_id: IDS.blackMonitorEvidence,
      variant_id: IDS.blackMonitor,
      field: "attribute.colour",
      raw_name: "colour",
      value: JSON.stringify("black"),
      observed_at: SEARCH_OBSERVED_AT,
      mapping_status: "accepted",
      canonical_attribute_id: colourAttribute.id,
    },
    // The 24-inch variant's "grijs" claim was never reviewed.
    {
      evidence_id: IDS.greyMonitorEvidence,
      variant_id: IDS.greyMonitorUnknownColour,
      field: "attribute.kleur",
      raw_name: "kleur",
      value: JSON.stringify("grijs"),
      observed_at: SEARCH_OBSERVED_AT,
      mapping_status: "unresolved",
      canonical_attribute_id: null,
    },
  ]);
}

describe("catalogue search through the core", () => {
  let db: Knex;
  let core: ReturnType<typeof createShoppingCore>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    await loadDevelopmentFixtures(db);
    await seedSearchCatalogue(db);
    core = createShoppingCore({
      db,
      models: {
        cipher: createSecretCipher({ key: "search-test-installation-secret" }),
        probe: async () => {
          throw new Error("search never probes a model");
        },
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("finds a variant by its exact model identifier and preserves it verbatim", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "VP27-BLK" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.variant.id)).toEqual([IDS.blackMonitor]);
    const hit = result.value.results[0]!;
    expect(hit.identifiers).toEqual({
      gtin: "8710000000017",
      manufacturerPartNumber: "VP27-BLK",
    });
    expect(hit.match).toEqual({ mode: "identifier", kind: "model", value: "VP27-BLK" });
  });

  it("accepts a model identifier typed in another letter case but keeps the stored spelling", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "vp27-blk" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.variant.id)).toEqual([IDS.blackMonitor]);
    expect(result.value.results[0]!.identifiers.manufacturerPartNumber).toBe("VP27-BLK");
    expect(result.value.results[0]!.match).toEqual({
      mode: "identifier",
      kind: "model",
      value: "vp27-blk",
    });
  });

  it("finds a variant by GTIN with surrounding whitespace ignored", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "  8720000000015 " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.variant.id)).toEqual([IDS.kettle]);
    expect(result.value.results[0]!.identifiers.gtin).toBe("8720000000015");
  });

  it("does not treat a partial model identifier as an exact match", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "VP27" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.match.mode)).not.toContain("identifier");
  });

  it("applies structured filters only to canonical attribute values", async () => {
    const result = await core.catalogue.search(anonymous, {
      filters: [{ key: "colour", value: "black" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.results.map((hit) => hit.variant.id);
    expect(ids).toContain(IDS.blackMonitor);
    expect(ids).toContain(IDS.kettle);
    // "grijs" exists only as an unresolved claim, so this variant is not a
    // verified colour match for grey or for any other colour.
    expect(ids).not.toContain(IDS.greyMonitorUnknownColour);
    const grey = await core.catalogue.search(anonymous, {
      filters: [{ key: "colour", value: "grey" }],
    });
    expect(grey.ok && grey.value.results).toEqual([]);
  });

  it("compares numeric filters numerically and never guesses an absent value", async () => {
    // The development fixture carries power in usb_c_power_delivery_w, not the
    // canonical power_w, so a power_w filter cannot claim it.
    const powerful = await core.catalogue.search(anonymous, {
      filters: [{ key: "power_w", op: "gte", value: "100" }],
    });
    expect(powerful.ok).toBe(true);
    if (!powerful.ok) return;
    expect(powerful.value.results.map((hit) => hit.variant.id).sort()).toEqual(
      [IDS.kettle, IDS.fridge].sort(),
    );
    expect(powerful.value.results.map((hit) => hit.variant.id)).not.toContain(
      DEVELOPMENT_FIXTURE_IDS.variantId,
    );

    const monitors = await core.catalogue.search(anonymous, {
      filters: [
        { key: "power_w", op: "gte", value: "100" },
        { key: "screen_size_inch", op: "gte", value: "27" },
      ],
    });
    expect(monitors.ok).toBe(true);
    if (!monitors.ok) return;
    // The kettle and the fridge are powerful enough but have no screen size, so
    // they cannot satisfy the second filter: absent is not a match.
    expect(monitors.value.results).toEqual([]);

    const sized = await core.catalogue.search(anonymous, {
      filters: [{ key: "screen_size_inch", op: "lte", value: "25" }],
    });
    expect(sized.ok).toBe(true);
    if (!sized.ok) return;
    expect(sized.value.results.map((hit) => hit.variant.id)).toEqual([
      IDS.greyMonitorUnknownColour,
    ]);
  });

  it("rejects a non-numeric value for a numeric attribute instead of comparing text", async () => {
    const result = await core.catalogue.search(anonymous, {
      filters: [{ key: "power_w", op: "gte", value: "lots" }],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "filters.power_w",
        message: "power_w takes a number",
      },
    });
  });

  it("rejects an operator the filter does not support", async () => {
    const result = await core.catalogue.search(anonymous, {
      filters: [{ key: "power_w", op: "approx" as never, value: "90" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid-input");
  });

  it("rejects filters naming an attribute that is not in the canonical vocabulary", async () => {
    const result = await core.catalogue.search(anonymous, {
      filters: [{ key: "mystery power", value: "90" }],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "filters.mystery power",
        message: "mystery power is not a filterable catalogue attribute",
      },
    });
  });

  it("expands Dutch wording to English-language catalogue text and the reverse", async () => {
    const dutch = await core.catalogue.search(anonymous, { text: "monitoren" });
    expect(dutch.ok).toBe(true);
    if (!dutch.ok) return;
    expect(dutch.value.results.map((hit) => hit.variant.id)).toContain(IDS.blackMonitor);
    expect(dutch.value.expansion).toContainEqual(
      expect.objectContaining({
        concept: "monitor",
        matched: "monitoren",
        approximate: false,
      }),
    );
    const monitorForms = dutch.value.expansion.find((entry) => entry.concept === "monitor");
    expect(monitorForms?.terms).toEqual(expect.arrayContaining(["monitor", "monitoren"]));
    expect(monitorForms?.terms).toEqual(expect.arrayContaining(["beeldscherm"]));

    const english = await core.catalogue.search(anonymous, { text: "waterkoker" });
    expect(english.ok).toBe(true);
    if (!english.ok) return;
    // The catalogue names it "Waterkoker"; "waterkoker" is Dutch, and its
    // English sibling "kettle" must reach it too.
    expect(english.value.results.map((hit) => hit.variant.id)).toContain(IDS.kettle);
    const kettleEnglish = await core.catalogue.search(anonymous, { text: "kettle" });
    expect(kettleEnglish.ok && kettleEnglish.value.results.map((hit) => hit.variant.id)).toContain(
      IDS.kettle,
    );
  });

  it("recovers from a Dutch spelling that only English stemming would miss", async () => {
    // "fridge"/"koelkast": no stemming configuration unites these, so this
    // proves the vocabulary expansion rather than a stemmer.
    const result = await core.catalogue.search(anonymous, { text: "koelkast" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.variant.id)).toContain(IDS.fridge);
  });

  it("tolerates a typo in a product term", async () => {
    const result = await core.catalogue.search(anonymous, { text: "monitr" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map((hit) => hit.variant.id)).toContain(IDS.blackMonitor);
    // The typo was understood as the monitor concept, not left unexplained.
    expect(result.value.expansion).toContainEqual(
      expect.objectContaining({ concept: "monitor", matched: "monitr", approximate: true }),
    );
    expect(result.value.results[0]!.unmatchedTerms).toEqual([]);
  });

  it("handles a mixed-language query in one search", async () => {
    const result = await core.catalogue.search(anonymous, {
      text: "zwarte 27 inch monitor",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.results.map((hit) => hit.variant.id);
    expect(ids).toContain(IDS.blackMonitor);
    expect(ids).not.toContain(IDS.greyMonitorUnknownColour);
    expect(ids).not.toContain(IDS.kettle);
    // The black monitor is the exact match; a white 27-inch monitor is a looser
    // one and must not be presented as equal to it.
    expect(ids.indexOf(IDS.blackMonitor)).toBeLessThan(ids.indexOf(IDS.whiteMonitor));
    expect(result.value.results.find((hit) => hit.variant.id === IDS.blackMonitor)?.match.mode)
      .toBe("text");
  });

  it("combines text with a structured filter", async () => {
    const result = await core.catalogue.search(anonymous, {
      text: "monitor",
      filters: [{ key: "colour", value: "white" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Every hit must satisfy both: the text search and the white colour.
    const ids = result.value.results.map((hit) => hit.variant.id);
    expect(ids).toContain(IDS.whiteMonitor);
    expect(ids).not.toContain(IDS.blackMonitor);
    expect(ids).not.toContain(IDS.greyMonitorUnknownColour);
    expect(result.value.results.find((hit) => hit.variant.id === IDS.whiteMonitor)?.match)
      .toEqual({ mode: "attribute", value: "white" });
  });

  it("returns an empty result set instead of an error when nothing matches", async () => {
    const result = await core.catalogue.search(anonymous, { text: "tosti ijzer" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toEqual([]);
  });

  it("exposes sources, uncertainty and timestamps on every result card", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "VP27-BLK" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.results[0]!;
    expect(hit.uncertainty).toBe("verified");
    expect(hit.sources).toEqual([
      {
        sourceUrl: "https://voorbeeldwinkel.example.test/vantage-pro-27-zwart",
        observedAt: SEARCH_OBSERVED_AT.toISOString(),
      },
    ]);
    expect(hit.variant.attributes).toMatchObject({ colour: "black" });
    expect(hit.attributeProvenance.colour).toEqual({
      status: "verified",
      sourceUrl: "https://voorbeeldwinkel.example.test/vantage-pro-27-zwart",
      observedAt: SEARCH_OBSERVED_AT.toISOString(),
    });
    expect(hit.offers.best?.amount).toBe("349.00");
    expect(hit.offers.best?.deliveredAmount).toBe("349.00");
    expect(hit.offers.best?.currency).toBe("EUR");
    expect(hit.offers.best?.observedAt).toBe(SEARCH_OBSERVED_AT.toISOString());
    expect(hit.offers.unknownPriceCount).toBe(0);
  });

  it("picks the cheapest delivered total exactly, not by floating point", async () => {
    // Two offers on one variant: 44.90 delivered and 44.9 (same value), plus a
    // third whose delivered total is lower. Money stays string-exact.
    await db("offers").insert({
      id: "b0000000-0000-4000-8000-000000000033",
      variant_id: IDS.kettle,
      retailer_id: IDS.retailer,
      url: "https://voorbeeldwinkel.example.test/huismerk-waterkoker-tweede",
      condition: "new",
    });
    await db("price_observations").insert([
      {
        offer_id: "b0000000-0000-4000-8000-000000000033",
        amount: "34.95",
        currency: "EUR",
        shipping_amount: "4.95",
        vat_included: true,
        source_kind: "retailer_page",
        observed_at: SEARCH_OBSERVED_AT,
      },
    ]);
    const result = await core.catalogue.search(anonymous, { identifiers: "HM-WK17" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results[0]!.offers.best?.amount).toBe("34.95");
    expect(result.value.results[0]!.offers.best?.deliveredAmount).toBe("39.90");
    expect(result.value.results[0]!.offers.unknownPriceCount).toBe(0);
  });

  it("labels a result whose price was never observed as uncertain", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "VP27-WHT" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.results[0]!;
    expect(hit.offers.best).toBeNull();
    expect(hit.offers.unknownPriceCount).toBe(0);
    expect(hit.uncertainty).toBe("verified");
  });

  it("marks the unmatched remainder of a text query as uncertain", async () => {
    const result = await core.catalogue.search(anonymous, { text: "waterkoker rvs" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.results.find((item) => item.variant.id === IDS.kettle);
    expect(hit).toBeDefined();
    // "rvs" appears in the variant name, so nothing is left unexplained.
    expect(hit!.unmatchedTerms).toEqual([]);
    expect(hit!.uncertainty).toBe("verified");
    const loose = await core.catalogue.search(anonymous, { text: "waterkoker zalmkleur" });
    expect(loose.ok).toBe(true);
    if (!loose.ok) return;
    const looseHit = loose.value.results.find((item) => item.variant.id === IDS.kettle);
    expect(looseHit?.unmatchedTerms).toContain("zalmkleur");
    expect(looseHit?.uncertainty).toBe("partial");
  });

  it("never reports an unresolved claim as a verified attribute in the detail view", async () => {
    const detail = await core.catalogue.getVariantOfferDetail(
      anonymous,
      IDS.greyMonitorUnknownColour,
    );
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.variant.attributes).not.toHaveProperty("colour");
    // The page carries a claim nobody has reviewed, so it is labelled partial,
    // and the values it does show have no accepted claim behind them.
    expect(detail.value.uncertainty.overall).toBe("partial");
    expect(detail.value.uncertainty.unverifiedAttributes).toEqual(
      expect.arrayContaining([
        { key: "power_w", status: "unverified", sourceUrl: null, observedAt: null },
      ]),
    );
    expect(detail.value.claims).toContainEqual(
      expect.objectContaining({
        field: "attribute.kleur",
        mappingStatus: "unresolved",
        sourceUrl: "https://voorbeeldwinkel.example.test/vantage-pro-24",
      }),
    );
    const unresolved = detail.value.claims.find((claim) => claim.mappingStatus === "unresolved");
    expect(unresolved?.observedAt).toBe(SEARCH_OBSERVED_AT.toISOString());
  });

  it("labels attributes verified by an accepted claim in the detail view", async () => {
    const detail = await core.catalogue.getVariantOfferDetail(anonymous, IDS.blackMonitor);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.variant.attributes).toMatchObject({ colour: "black" });
    expect(detail.value.uncertainty.overall).toBe("verified");
    expect(detail.value.uncertainty.unverifiedAttributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "screen_size_inch", status: "unverified" }),
      ]),
    );
    expect(
      detail.value.uncertainty.unverifiedAttributes.find((entry) => entry.key === "colour"),
    ).toEqual({
      key: "colour",
      status: "verified",
      sourceUrl: "https://voorbeeldwinkel.example.test/vantage-pro-27-zwart",
      observedAt: SEARCH_OBSERVED_AT.toISOString(),
    });
  });

  it("rejects an empty search instead of scanning the catalogue", async () => {
    const result = await core.catalogue.search(anonymous, {});
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "query",
        message: "Provide a model identifier, search text, or a filter",
      },
    });
  });

  it("rejects text longer than the search bound", async () => {
    const result = await core.catalogue.search(anonymous, { text: "a".repeat(201) });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "text",
        message: "text must be 200 characters or fewer",
      },
    });
  });

  it("finds the development fixture by its model identifier", async () => {
    const result = await core.catalogue.search(anonymous, { identifiers: "U2723QE" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.results.find(
      (item) => item.variant.id === DEVELOPMENT_FIXTURE_IDS.variantId,
    );
    expect(hit?.identifiers.manufacturerPartNumber).toBe("U2723QE");
    expect(hit?.variant.product.isDevelopmentFixture).toBe(true);
    expect(hit?.offers.best?.amount).toBe("559.00");
  });
});
