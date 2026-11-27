import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, migrate } from "@shopping-assistant/database/testing";
import { createEngine, type Engine } from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

/**
 * The evidence store against the real database.
 *
 * Every page is fed through `engine.extraction.parse`, so no test reaches the
 * network and nothing is charged to a research run: parsing a page the caller
 * already holds is the pure path, and it is the one a fixture should take. The
 * persistence is real, and it is the point: products, exact variants, offers,
 * and their evidence must survive a reload exactly as they were stored, and a
 * re-read of the same page must refresh the offer without losing the first
 * check's evidence.
 */

const URL_A = "https://shop.example/en/p/bike-helmet-300";
const URL_B = "https://shop.example/en/p/bike-helmet-300-large";
const URL_C1 = "https://shop.example/en/p/helmet-1";
const URL_C2 = "https://shop.example/en/p/helmet-2";
const URL_D = "https://shop.example/en/p/plain-helmet";

/** A complete page: identifiers, product facts, and a full offer. */
const FIXTURE_A = `<!doctype html>
<html><head><title>Trail Helmet 300</title>
  <script type="application/ld+json">
  {"@type":"Product","name":"Trail Helmet 300","brand":{"@type":"Brand","name":"Example Outdoors"},
   "sku":"TH-300","gtin13":"4006381333931","category":"Cycling > Helmets",
   "description":"A ventilated helmet for trail riding.","image":"/media/helmet.jpg",
   "offers":{"@type":"Offer","price":"89.95","priceCurrency":"EUR",
   "availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition",
   "url":"/en/p/bike-helmet-123","priceValidUntil":"2026-12-31"}}
  </script>
</head><body><h1>Trail Helmet 300</h1></body></html>`;

/** A second configuration of the same model: a different sku and gtin, a larger image. */
const FIXTURE_B = `<!doctype html>
<html><head><title>Trail Helmet 300</title>
  <script type="application/ld+json">
  {"@type":"Product","name":"Trail Helmet 300","brand":{"@type":"Brand","name":"Example Outdoors"},
   "sku":"TH-300-L","gtin13":"4006381333932","image":"/media/helmet-large.jpg",
   "offers":{"@type":"Offer","price":"94.95","priceCurrency":"EUR",
   "availability":"https://schema.org/InStock","itemCondition":"https://schema.org/NewCondition",
   "url":"/en/p/bike-helmet-300-large"}}
  </script>
</head><body><h1>Trail Helmet 300</h1></body></html>`;

/** An ambiguous page: it states a name and a price, and not one identifier. */
const FIXTURE_C = `<!doctype html>
<html><head><title>Trail Helmet 300</title>
  <script type="application/ld+json">
  {"@type":"Product","name":"Trail Helmet 300",
   "offers":{"@type":"Offer","price":"79.00","priceCurrency":"EUR"}}
  </script>
</head><body><h1>Trail Helmet 300</h1></body></html>`;

/** A page that states a price and availability, but no condition. */
const FIXTURE_D = `<!doctype html>
<html><head><title>Plain Helmet</title>
  <script type="application/ld+json">
  {"@type":"Product","name":"Plain Helmet","brand":{"@type":"Brand","name":"Example Outdoors"},
   "sku":"PH-1",
   "offers":{"@type":"Offer","price":"89.95","priceCurrency":"EUR",
   "availability":"https://schema.org/InStock"}}
  </script>
</head><body><h1>Plain Helmet</h1></body></html>`;

let server: Database;
let current: Date;

interface Installation {
  database: Database;
  engine: Engine;
  drop: () => Promise<void>;
}

async function createInstallation(): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  // A fixed clock, advanced between checks so a check time is asserted
  // exactly rather than approximately.
  current = new Date("2026-11-28T09:00:00.000Z");
  const engine = createEngine({
    database,
    setupToken: "unused-in-these-tests",
    identity: createFakeIdentityStore(database),
    now: () => current,
  });
  return { database, engine, drop };
}

async function discard(installation: Installation): Promise<void> {
  await installation.database.destroy();
  await installation.drop();
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("ingesting a page", () => {
  it("stores the product, the exact variant, the offer, and every stated fact", async () => {
    const installation = await createInstallation();
    const stored = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_A, html: FIXTURE_A }),
    );
    expect(stored).toEqual({ stored: true, productId: expect.any(String) });
    if (!stored.stored) return;

    const details = await installation.engine.evidence.product(stored.productId);
    expect(details).toBeDefined();
    if (!details) return;

    expect(details.name).toBe("Trail Helmet 300");
    expect(details.brand).toBe("Example Outdoors");
    expect(details.category).toBe("Cycling > Helmets");
    expect(details.createdAt).toBeInstanceOf(Date);

    // Product-level facts are evidence on the product.
    expect(details.facts.map((fact) => fact.field).sort()).toEqual([
      "brand",
      "category",
      "description",
      "name",
    ]);

    const variant = details.variants[0];
    if (!variant) return;
    expect(details.variants).toHaveLength(1);
    expect(variant.fingerprint).toBe("gtin:4006381333931");
    expect(variant.attrs).toEqual({
      sku: "TH-300",
      gtin: "4006381333931",
      imageUrl: "https://shop.example/media/helmet.jpg",
    });
    // The identifiers and the image are variant-level evidence.
    expect(variant.facts.map((fact) => fact.field).sort()).toEqual([
      "gtin",
      "imageUrl",
      "sku",
    ]);

    const offer = variant.offers[0];
    if (!offer) return;
    expect(offer.retailer).toBe("shop.example");
    expect(offer.purchaseUrl).toBe("https://shop.example/en/p/bike-helmet-123");
    expect(offer.priceCents).toBe(8995);
    expect(offer.currency).toBe("EUR");
    expect(offer.availability).toBe("in_stock");
    expect(offer.condition).toBe("new");
    expect(offer.checkedAt).toEqual(new Date("2026-11-28T09:00:00.000Z"));

    const offerFields = offer.facts.map((fact) => fact.field);
    // Seller is not stated by this page, so it is deliberately absent: a fact
    // row exists only for a fact the page stated.
    for (const field of ["price", "priceValidUntil", "availability", "condition", "url"]) {
      expect(offerFields).toContain(field);
    }
    expect(offerFields).not.toContain("seller");
    expect(offer.facts.find((fact) => fact.field === "price")?.value).toBe("89.95");
    // Every fact names the page it came from and the time it was checked.
    for (const fact of [...details.facts, ...variant.facts, ...offer.facts]) {
      expect(fact.sourceUrl).toBe(URL_A);
      expect(fact.checkTime).toEqual(new Date("2026-11-28T09:00:00.000Z"));
    }
    await discard(installation);
  });

  it("stores nothing for a page that was not extracted", async () => {
    const installation = await createInstallation();
    // A failed retrieval: there is no body to read.
    const failed = await installation.engine.evidence.ingest({
      ok: false,
      outcome: "failed",
      failure: { kind: "failed", detail: "connection refused" },
      allowanceReached: false,
      requestedUrl: URL_A,
      checkedAt: new Date("2026-11-28T09:00:00.000Z"),
      fetches: 1,
      durationMs: 5,
    });
    expect(failed).toEqual({ stored: false, reason: "failed" });

    // A page that was read but is not a product carries no facts at all.
    const notExtracted = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({
        url: URL_A,
        html: "<html><body><p>Welcome to our shop.</p></body></html>",
      }),
    );
    expect(notExtracted).toEqual({ stored: false, reason: "no_facts" });

    expect(await installation.database("products").count("*")).toMatchObject([{ count: "0" }]);
    await discard(installation);
  });
});

describe("re-ingesting a page", () => {
  it("keeps one product and one variant, refreshes the offer, and keeps both checks as evidence", async () => {
    const installation = await createInstallation();
    const stored = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_A, html: FIXTURE_A }),
    );
    if (!stored.stored) return;

    // A later check of the same page.
    current = new Date("2026-11-28T10:00:00.000Z");
    const again = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_A, html: FIXTURE_A }),
    );
    expect(again).toEqual({ stored: true, productId: stored.productId });

    const details = await installation.engine.evidence.product(stored.productId);
    expect(details).toBeDefined();
    if (!details) return;
    expect(details.variants).toHaveLength(1);
    const variant = details.variants[0];
    if (!variant) return;
    expect(variant.id).toBeDefined();
    expect(variant.offers).toHaveLength(1);

    const offer = variant.offers[0];
    if (!offer) return;
    // The offer now carries the later check time and the same checked values.
    expect(offer.checkedAt).toEqual(new Date("2026-11-28T10:00:00.000Z"));
    expect(offer.priceCents).toBe(8995);
    // Both checks remain as evidence, each with its own check time.
    const priceFacts = offer.facts.filter((fact) => fact.field === "price");
    expect(priceFacts).toHaveLength(2);
    expect(priceFacts.map((fact) => fact.checkTime)).toEqual([
      new Date("2026-11-28T10:00:00.000Z"),
      new Date("2026-11-28T09:00:00.000Z"),
    ]);
    await discard(installation);
  });

  it("leaves prior observations untouched when a later extraction fails", async () => {
    const installation = await createInstallation();
    const stored = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_A, html: FIXTURE_A }),
    );
    if (!stored.stored) return;
    const before = await installation.engine.evidence.product(stored.productId);
    if (!before) return;
    const evidenceBefore = before.variants[0]?.offers[0]?.facts.length ?? 0;

    current = new Date("2026-11-28T11:00:00.000Z");
    const failed = await installation.engine.evidence.ingest({
      ok: false,
      outcome: "failed",
      failure: { kind: "timeout", limitMs: 10_000 },
      allowanceReached: false,
      requestedUrl: URL_A,
      checkedAt: current,
      fetches: 1,
      durationMs: 10_000,
    });
    expect(failed).toEqual({ stored: false, reason: "failed" });

    const after = await installation.engine.evidence.product(stored.productId);
    expect(after).toBeDefined();
    if (!after) return;
    expect(after.variants).toHaveLength(1);
    const offer = after.variants[0]?.offers[0];
    if (!offer) return;
    expect(offer.priceCents).toBe(8995);
    // The offer was not re-checked: its check time and evidence stand.
    expect(offer.checkedAt).toEqual(new Date("2026-11-28T09:00:00.000Z"));
    expect(offer.facts.length).toBe(evidenceBefore);
    await discard(installation);
  });
});

describe("matching identities conservatively", () => {
  it("keeps two configurations with conflicting identifiers as two variants of one product", async () => {
    const installation = await createInstallation();
    await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_A, html: FIXTURE_A }),
    );
    const second = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_B, html: FIXTURE_B }),
    );
    if (!second.stored) return;

    const details = await installation.engine.evidence.product(second.productId);
    expect(details).toBeDefined();
    if (!details) return;
    expect(details.name).toBe("Trail Helmet 300");
    // One product line, and each configuration keeps its own variant: the two
    // pages were not silently collapsed.
    expect(details.variants).toHaveLength(2);
    expect(details.variants.map((variant) => variant.fingerprint).sort()).toEqual([
      "gtin:4006381333931",
      "gtin:4006381333932",
    ]);
    const [first, secondVariant] = details.variants;
    expect(first?.id).not.toBe(secondVariant?.id);
    expect(first?.offers[0]?.priceCents).toBe(8995);
    expect(secondVariant?.offers[0]?.priceCents).toBe(9495);
    expect(secondVariant?.attrs.imageUrl).toBe("https://shop.example/media/helmet-large.jpg");
    await discard(installation);
  });

  it("never merges two pages that share no identifier", async () => {
    const installation = await createInstallation();
    await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_C1, html: FIXTURE_C }),
    );
    const second = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_C2, html: FIXTURE_C }),
    );
    if (!second.stored) return;

    const details = await installation.engine.evidence.product(second.productId);
    expect(details).toBeDefined();
    if (!details) return;
    // Same product line, same name, not one identifier: the pages still stay
    // apart, because the fallback fingerprint binds the page's own URL.
    expect(details.variants).toHaveLength(2);
    const [first, secondVariant] = details.variants;
    expect(first?.id).not.toBe(secondVariant?.id);
    expect(first?.fingerprint).toContain("name:trail helmet 300");
    expect(secondVariant?.fingerprint).toContain("name:trail helmet 300");
    expect(first?.fingerprint).not.toBe(secondVariant?.fingerprint);
    // Each ambiguous page still gets its own offer.
    expect(details.variants.flatMap((variant) => variant.offers)).toHaveLength(2);
    await discard(installation);
  });

  it("does not fold a same-named product from another brand into the first", async () => {
    const installation = await createInstallation();
    await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_A, html: FIXTURE_A }),
    );
    const otherBrand = FIXTURE_A.replace(
      '"name":"Example Outdoors"',
      '"name":"Other Shop"',
    );
    const second = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_B, html: otherBrand }),
    );
    if (!second.stored) return;
    // A same-named product with a different brand is its own product line.
    const firstDetails = await installation.engine.evidence.product(second.productId);
    expect(firstDetails).toBeDefined();
    if (!firstDetails) return;
    expect(firstDetails.brand).toBe("Other Shop");
    expect(firstDetails.variants).toHaveLength(1);
    expect(
      await installation.database("products").count("*"),
    ).toMatchObject([{ count: "2" }]);
    await discard(installation);
  });
});

describe("reading structured details", () => {
  it("distinguishes stated values from missing facts on reload", async () => {
    const installation = await createInstallation();
    const stored = await installation.engine.evidence.ingest(
      installation.engine.extraction.parse({ url: URL_D, html: FIXTURE_D }),
    );
    if (!stored.stored) return;

    const details = await installation.engine.evidence.product(stored.productId);
    expect(details).toBeDefined();
    if (!details) return;

    // Product-level facts (name, brand) are evidence on the product.
    expect(details.facts.map((fact) => fact.field).sort()).toEqual(["brand", "name"]);
    for (const fact of details.facts) {
      expect(fact.sourceUrl).toBe(URL_D);
      expect(fact.checkTime).toEqual(new Date("2026-11-28T09:00:00.000Z"));
    }

    const variant = details.variants[0];
    if (!variant) return;
    expect(variant.fingerprint).toBe("sku:ph-1");
    expect(variant.attrs).toEqual({ sku: "PH-1" });
    expect(variant.facts.map((fact) => fact.field)).toEqual(["sku"]);

    const offer = variant.offers[0];
    if (!offer) return;
    expect(offer.purchaseUrl).toBe(URL_D);
    expect(offer.priceCents).toBe(8995);
    expect(offer.currency).toBe("EUR");
    expect(offer.availability).toBe("in_stock");
    // Condition was not stated: it is null, never an invented value, and there
    // is no evidence row pretending it was checked.
    expect(offer.condition).toBeNull();
    const fields = offer.facts.map((fact) => fact.field);
    expect(fields).toContain("price");
    expect(fields).toContain("availability");
    expect(fields).not.toContain("condition");
    expect(offer.facts.find((fact) => fact.field === "price")?.value).toBe("89.95");
    await discard(installation);
  });

  it("reports no product for an unknown id", async () => {
    const installation = await createInstallation();
    expect(
      await installation.engine.evidence.product("00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
    await discard(installation);
  });
});