// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  createDb,
  DEFAULT_TEST_DATABASE_URL,
  DEVELOPMENT_FIXTURE_IDS,
  loadDevelopmentFixtures,
  migrateFresh,
} from "@shopping/db";
import { createShoppingCore, createSecretCipher, type Principal } from "../src/index";

// Core is the primary testing seam: read a catalogue variant through the
// engine against real PostgreSQL, including authorization and failure shapes.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const anonymous: Principal = { kind: "anonymous" };
const shopper: Principal = {
  kind: "workspace",
  userId: "user-fixture",
  workspaceId: "workspace-fixture",
  sessionId: "session-fixture",
};

describe("catalogue reads through the core", () => {
  let db: Knex;
  let core: ReturnType<typeof createShoppingCore>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await migrateFresh(db);
    await loadDevelopmentFixtures(db);
    core = createShoppingCore({
      db,
      models: {
        cipher: createSecretCipher({ key: "catalogue-test-installation-secret" }),
        probe: async () => {
          throw new Error("the catalogue seam never probes a model");
        },
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("returns the example variant with its offer and latest observation", async () => {
    const result = await core.catalogue.getVariantOfferDetail(
      anonymous,
      DEVELOPMENT_FIXTURE_IDS.variantId,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const detail = result.value;
    expect(detail.variant.product.name).toBe("Dell UltraSharp U2723QE");
    expect(detail.variant.product.isDevelopmentFixture).toBe(true);
    expect(detail.variant.attributes).toMatchObject({
      screen_size_inch: 27,
      usb_c_power_delivery_w: 90,
    });

    expect(detail.offers).toHaveLength(1);
    const offer = detail.offers[0]!;
    expect(offer.condition).toBe("new");
    expect(offer.retailer.name).toBe("Coolblue");
    expect(offer.currentPrice).not.toBeNull();
    expect(offer.currentPrice?.amount).toBe("559.00");
    expect(offer.currentPrice?.deliveredAmount).toBe("559.00");
    expect(offer.currentPrice?.currency).toBe("EUR");
    expect(offer.currentPrice?.vatIncluded).toBe(true);
  });

  it("is equally readable for an identified workspace shopper", async () => {
    const result = await core.catalogue.getVariantOfferDetail(
      shopper,
      DEVELOPMENT_FIXTURE_IDS.variantId,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed identifier before touching data", async () => {
    const result = await core.catalogue.getVariantOfferDetail(
      anonymous,
      "not-a-uuid",
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "variantId",
        message: "variantId must be a UUID",
      },
    });
  });

  it("reports an unknown variant as not-found", async () => {
    const result = await core.catalogue.getVariantOfferDetail(
      anonymous,
      "00000000-0000-4000-8000-00000000dead",
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "not-found",
        resource: "variant",
        id: "00000000-0000-4000-8000-00000000dead",
      },
    });
  });
});

const PAGE = `<!doctype html><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Product", name: "Acme Sound 1", brand: { name: "Acme" }, gtin13: "1234567890005", sku: "LOCAL-1",
  additionalProperty: [{ name: "colour", value: "blue" }],
  offers: { "@type": "Offer", price: "99.95", priceCurrency: "EUR", seller: { name: "Marketplace seller" } },
})}</script>`;

describe("catalogue page ingestion through the core", () => {
  const permitted = (url: URL) => url.hostname === "shop.example.test"
    ? { retailerName: "Example Shop", baseUrl: "https://shop.example.test", hosts: ["shop.example.test"] }
    : null;
  const shopper: Principal = { kind: "workspace", userId: "user", workspaceId: "workspace", sessionId: "session" };
  let db: Knex;
  let core: ReturnType<typeof createShoppingCore>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await migrateFresh(db);
    core = createShoppingCore({ db, ingestion: { sourcePolicy: permitted, resolve: async () => ["203.0.113.10"], fetch: async () => new Response(PAGE), now: () => new Date("2026-11-19T10:00:00Z") }, models: { cipher: createSecretCipher({ key: "catalogue-test-installation-secret" }), probe: async () => { throw new Error("unused"); } } });
  });
  afterAll(async () => { await db.destroy(); });

  it("persists inspectable product, variant, local SKU, seller and evidence idempotently", async () => {
    const first = await core.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    const second = await core.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    expect(first).toEqual(second);
    if (!first.ok) return;
    expect(await db("source_claims").where({ evidence_id: first.value.evidenceId }).count("* as count").first()).toMatchObject({ count: "4" });
    expect(await db("offers").where({ id: first.value.offerId }).first()).toMatchObject({ retailer_sku: "LOCAL-1", seller_name: "Marketplace seller" });
    const detail = await core.catalogue.getVariantOfferDetail(anonymous, first.value.variantId);
    expect(detail.ok && detail.value.offers[0]?.currentPrice?.amount).toBe("99.95");
    expect(detail.ok && detail.value.claims).toContainEqual(expect.objectContaining({ field: "offer", sourceUrl: "https://shop.example.test/products/sound-1" }));
  });

  it("keeps unfamiliar claims unresolved and lets only an administrator validate a canonical mapping", async () => {
    const unknown = createShoppingCore({ db, ingestion: { sourcePolicy: permitted, resolve: async () => ["203.0.113.10"], fetch: async () => new Response(PAGE.replace("1234567890005", "2345678901005").replace('name":"colour","value":"blue', 'name":"mystery power","value":"90')), now: () => new Date("2026-11-19T10:00:00Z") }, models: { cipher: createSecretCipher({ key: "catalogue-test-installation-secret" }), probe: async () => { throw new Error("unused"); } } });
    const result = await unknown.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/unknown-attribute");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = await core.catalogue.getVariantOfferDetail(anonymous, result.value.variantId);
    expect(before.ok && before.value.variant.attributes).not.toHaveProperty("mystery power");
    expect(before.ok && before.value.claims).toContainEqual(expect.objectContaining({
      field: "attribute.mystery power", mappingStatus: "unresolved",
    }));

    const denied = await core.catalogue.listAttributeReviews(shopper);
    expect(denied).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });
    const queue = await core.catalogue.listAttributeReviews({ kind: "administrator", userId: "admin", workspaceId: "workspace", sessionId: "session" });
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    const claim = queue.value.find((item) => item.rawName === "mystery power");
    expect(claim).toBeDefined();
    if (!claim) return;

    expect(await core.catalogue.reviewAttributeClaim(shopper, claim.id, "power_w")).toEqual({
      ok: false, error: { kind: "forbidden", capability: "installation.manage" },
    });
    expect(await db("source_claims").where({ id: claim.id }).first()).toMatchObject({ mapping_status: "unresolved" });
    const attribute = await db("catalogue_attributes").where({ key: "power_w" }).first();
    await db("attribute_assessments").insert({ variant_id: result.value.variantId, attribute_id: attribute.id });
    expect(await core.catalogue.reviewAttributeClaim({ kind: "administrator", userId: "admin", workspaceId: "workspace", sessionId: "session" }, claim.id, "power_w")).toMatchObject({ ok: true });
    expect(await db("attribute_assessments").where({ variant_id: result.value.variantId }).first()).toMatchObject({ invalidated_at: expect.any(Date) });
    const after = await core.catalogue.getVariantOfferDetail(anonymous, result.value.variantId);
    expect(after.ok && after.value.variant.attributes).toMatchObject({ power_w: 90 });
  });

  it("normalizes supported units across categories without excluding unfamiliar attributes", async () => {
    const monitor = PAGE.replace("Acme Sound 1", "Acme Monitor 2").replace("1234567890005", "3456789012005").replace('name":"colour","value":"blue', 'name":"screen size","value":"68.58","unitText":"cm').replace('"@type":"Product",', '"@type":"Product","category":"Monitors",');
    const kitchen = PAGE.replace("Acme Sound 1", "Acme Kettle 3").replace("1234567890005", "4567890123005").replace('name":"colour","value":"blue', 'name":"watt","value":"1.8","unitCode":"kW').replace('"@type":"Product",', '"@type":"Product","category":"Kitchen",');
    const source = createShoppingCore({ db, ingestion: { sourcePolicy: permitted, resolve: async () => ["203.0.113.10"], fetch: async (url) => new Response(url.includes("monitor") ? monitor : kitchen), now: () => new Date("2026-11-19T10:00:00Z") }, models: { cipher: createSecretCipher({ key: "catalogue-test-installation-secret" }), probe: async () => { throw new Error("unused"); } } });
    const monitorResult = await source.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/monitor");
    const kitchenResult = await source.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/kitchen");
    expect(monitorResult.ok && kitchenResult.ok).toBe(true);
    if (!monitorResult.ok || !kitchenResult.ok) return;
    const monitorDetail = await source.catalogue.getVariantOfferDetail(anonymous, monitorResult.value.variantId);
    const kitchenDetail = await source.catalogue.getVariantOfferDetail(anonymous, kitchenResult.value.variantId);
    expect(monitorDetail.ok && monitorDetail.value.variant.product.category).toBe("Monitors");
    expect(monitorDetail.ok && monitorDetail.value.variant.attributes).toMatchObject({ screen_size_inch: 27 });
    expect(kitchenDetail.ok && kitchenDetail.value.variant.product.category).toBe("Kitchen");
    expect(kitchenDetail.ok && kitchenDetail.value.variant.attributes).toMatchObject({ power_w: 1800 });
  });

  it("rejects unsafe URLs, HTTP-200 challenge pages and conflicting configurations without replacing the observation", async () => {
    const before = await db("price_observations").count("* as count").first();
    await expect(core.catalogue.ingestProductPage(shopper, "http://127.0.0.1/private")).resolves.toMatchObject({ error: { kind: "unsafe-url" } });
    const challenge = createShoppingCore({ db, ingestion: { sourcePolicy: permitted, resolve: async () => ["203.0.113.10"], fetch: async () => new Response("captcha verify you are human") }, models: { cipher: createSecretCipher({ key: "catalogue-test-installation-secret" }), probe: async () => { throw new Error("unused"); } } });
    await expect(challenge.catalogue.ingestProductPage(shopper, "https://shop.example.test/challenge")).resolves.toMatchObject({ error: { kind: "source-fetch-failed", classification: "challenge" } });
    const conflictingPage = PAGE.replace('value":"blue', 'value":"red');
    const conflicting = createShoppingCore({ db, ingestion: { sourcePolicy: permitted, resolve: async () => ["203.0.113.10"], fetch: async () => new Response(conflictingPage) }, models: { cipher: createSecretCipher({ key: "catalogue-test-installation-secret" }), probe: async () => { throw new Error("unused"); } } });
    await expect(conflicting.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/other-listing")).resolves.toMatchObject({ error: { kind: "identity-conflict" } });
    expect(await core.catalogue.listAttributeReviews({ kind: "administrator", userId: "admin", workspaceId: "workspace", sessionId: "session" })).toMatchObject({ value: expect.arrayContaining([expect.objectContaining({ rawName: "colour", value: "red" })]) });
    expect(await db("price_observations").count("* as count").first()).toMatchObject({ count: before?.count });
  });
});
