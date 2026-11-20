// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL, resetSchema } from "@shopping/db";
import {
  createIngestion,
  createSecretCipher,
  createShoppingCore,
  type IngestionDependencies,
  type PermittedSource,
  type Principal,
} from "../src/index";

// Ingestion hardening at the core-engine seam: real PostgreSQL, a scripted
// page fetcher standing in for the network (never a real outbound request),
// and a resolver that names the destination address each host resolves to.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const shopper: Principal = {
  kind: "workspace",
  userId: "user-ingestion",
  workspaceId: "workspace-ingestion",
  sessionId: "session-ingestion",
};
const administrator: Principal = {
  kind: "administrator",
  userId: "admin-ingestion",
  workspaceId: "workspace-ingestion",
  sessionId: "session-ingestion",
};
const anonymous: Principal = { kind: "anonymous" };

const EXAMPLE_SHOP: PermittedSource = {
  retailerName: "Example Shop",
  baseUrl: "https://shop.example.test",
  hosts: ["shop.example.test"],
};

const PUBLIC_ADDRESS = "203.0.113.10";

function permitted(url: URL): PermittedSource | null {
  return url.hostname === "shop.example.test" ? EXAMPLE_SHOP : null;
}

function productPage(options: {
  name: string;
  gtin?: string | null;
  mpn?: string | null;
  sku?: string | null;
  price?: string;
  attributes?: Array<Record<string, unknown>>;
}): string {
  const product: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: options.name,
    brand: { name: "Acme" },
    offers: {
      "@type": "Offer",
      price: options.price ?? "99.95",
      priceCurrency: "EUR",
      seller: { name: "Example Shop" },
    },
  };
  if (options.gtin) product.gtin13 = options.gtin;
  if (options.mpn) product.mpn = options.mpn;
  if (options.sku) product.sku = options.sku;
  if (options.attributes) product.additionalProperty = options.attributes;
  return `<!doctype html><html><body><h1>${options.name}</h1><script type="application/ld+json">${JSON.stringify(product)}</script></body></html>`;
}

const BLUE_SOUND = productPage({
  name: "Acme Sound 1",
  gtin: "4006381330000",
  mpn: "ACME-S1",
  sku: "LOCAL-1",
  attributes: [{ name: "colour", value: "blue" }],
});

function core(ingestion: IngestionDependencies) {
  return createShoppingCore({
    db,
    ingestion,
    models: {
      cipher: createSecretCipher({ key: "ingestion-hardening-test-secret" }),
      probe: async () => {
        throw new Error("ingestion never probes a model");
      },
    },
  });
}

let db: Knex;

beforeAll(async () => {
  db = createDb(TEST_DATABASE_URL);
  await resetSchema(db);
  await db.migrate.latest();
});

afterAll(async () => {
  await db.destroy();
});

beforeEach(async () => {
  await db("ingestion_sources").delete();
  await db("source_claims").delete();
  await db("source_evidence").delete();
  await db("price_observations").delete();
  await db("offers").delete();
  await db("variants").delete();
  await db("products").delete();
  await db("retailers").delete();
});

describe("ingestion bounds what it fetches", () => {
  it("stops at the redirect limit instead of following an endless chain", async () => {
    const requested: string[] = [];
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date("2026-11-19T10:00:00Z"),
      fetch: async (url) => {
        requested.push(url);
        const hop = Number(new URL(url).searchParams.get("hop") ?? "0");
        return new Response(null, {
          status: 302,
          headers: { location: `https://shop.example.test/product?hop=${hop + 1}` },
        });
      },
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/product?hop=0");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "redirect" },
    });
    // One initial request plus the bounded number of hops, never the loop.
    expect(requested).toHaveLength(4);
  });

  it("follows an agreeing redirect within the permitted source", async () => {
    const requested: string[] = [];
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date("2026-11-19T10:00:00Z"),
      fetch: async (url) => {
        requested.push(url);
        if (url.endsWith("/old")) {
          return new Response(null, {
            status: 301,
            headers: { location: "https://shop.example.test/products/sound-1" },
          });
        }
        return new Response(BLUE_SOUND, { status: 200 });
      },
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/old");

    expect(requested).toEqual([
      "https://shop.example.test/old",
      "https://shop.example.test/products/sound-1",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = await db("source_evidence").where({ id: result.value.evidenceId }).first();
    expect(evidence).toMatchObject({
      source_url: "https://shop.example.test/old",
      final_url: "https://shop.example.test/products/sound-1",
    });
  });

  it("names the refused destination when a redirect leaves the permitted source", async () => {
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      fetch: async () => new Response(null, {
        status: 301,
        headers: { location: "https://elsewhere.example.test/promo" },
      }),
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "source-fetch-failed",
        classification: "redirect",
        sourceUrl: "https://shop.example.test/products/sound-1",
        url: "https://elsewhere.example.test/promo",
        status: 301,
      },
    });
  });

  it("refuses a redirect whose host resolves to a private destination before fetching it", async () => {
    const requested: string[] = [];
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async (hostname) => (hostname === "internal.example.test" ? ["10.0.0.7"] : [PUBLIC_ADDRESS]),
      now: () => new Date("2026-11-19T10:00:00Z"),
      fetch: async (url) => {
        requested.push(url);
        return new Response(null, {
          status: 307,
          headers: { location: "https://internal.example.test/private" },
        });
      },
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    // The hop itself is a well-formed, permitted host; what makes it unusable
    // is the address it resolves to. Either way nothing was requested from it.
    expect(result.ok).toBe(false);
    expect(requested).toEqual(["https://shop.example.test/products/sound-1"]);
  });

  it("rejects an unsafe initial URL before any fetch or lookup happens", async () => {
    const fetchCalls: string[] = [];
    const lookups: string[] = [];
    const ingest = createIngestion(db, {
      sourcePolicy: () => EXAMPLE_SHOP,
      resolve: async (hostname) => {
        lookups.push(hostname);
        return [PUBLIC_ADDRESS];
      },
      fetch: async (url) => {
        fetchCalls.push(url);
        return new Response(BLUE_SOUND, { status: 200 });
      },
    });

    for (const unsafe of [
      "http://shop.example.test/products/sound-1",
      "https://user:secret@shop.example.test/products/sound-1",
      "https://localhost/products/sound-1",
      "https://127.0.0.1/products/sound-1",
      "https://[::1]/products/sound-1",
      "https://169.254.169.254/latest/meta-data",
      "https://192.168.1.10/router",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const result = await ingest.ingestProductPage(shopper, unsafe);
      expect(result, unsafe).toMatchObject({ ok: false, error: { kind: "unsafe-url" } });
    }
    expect(fetchCalls).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("rejects a permitted host that resolves to a private address before fetching", async () => {
    const fetchCalls: string[] = [];
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => ["10.1.2.3"],
      fetch: async (url) => {
        fetchCalls.push(url);
        return new Response(BLUE_SOUND, { status: 200 });
      },
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({ ok: false, error: { kind: "unsafe-url" } });
    expect(fetchCalls).toEqual([]);
  });

  it("refuses a page larger than the size bound without persisting an excerpt", async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024, 0x78);
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date("2026-11-19T10:00:00Z"),
      fetch: async () => new Response(oversized, { status: 200 }),
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/huge");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "size" },
    });
    expect(await db("source_evidence").count("* as count").first()).toMatchObject({ count: "0" });
  });

  it("refuses a page that declares an oversized content length before reading it", async () => {
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      fetch: async () => new Response(BLUE_SOUND, {
        status: 200,
        headers: { "content-length": String(50_000_000) },
      }),
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "size" },
    });
  });

  it("abandons a fetch that outlives the timeout", async () => {
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      bounds: { timeoutMs: 200 },
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "timeout" },
    });
  });

  it("reports a source that cannot be resolved without fetching it", async () => {
    const fetchCalls: string[] = [];
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      fetch: async (url) => {
        fetchCalls.push(url);
        return new Response(BLUE_SOUND, { status: 200 });
      },
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "network" },
    });
    expect(fetchCalls).toEqual([]);
  });
});

describe("ingestion classifies what came back", () => {
  it("classifies an HTTP error response", async () => {
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      fetch: async () => new Response("gone", { status: 404 }),
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "http" },
    });
  });

  it("classifies a challenge served with HTTP 200", async () => {
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      fetch: async () => new Response(
        "<html><body>Just a moment... Verify you are human by completing the action below.</body></html>",
        { status: 200 },
      ),
    });

    const result = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "challenge" },
    });
  });

  it("records the fetch outcome so a failed check is visible", async () => {
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date("2026-11-19T10:00:00Z"),
      fetch: async () => new Response("blocked", { status: 403 }),
    });

    await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    const source = await db("ingestion_sources").where({ host: "shop.example.test" }).first();
    expect(source).toMatchObject({
      retailer_name: "Example Shop",
      last_success_at: null,
      last_failure_classification: "http",
    });
    expect(new Date(source.last_failure_at).toISOString()).toBe("2026-11-19T10:00:00.000Z");
  });
});

describe("ingestion merges only agreeing identities", () => {
  const SOUND = productPage({
    name: "Acme Sound 1",
    gtin: "4006381330000",
    mpn: "ACME-S1",
    sku: "LOCAL-1",
    attributes: [{ name: "colour", value: "blue" }],
  });
  /** The same listing with one field changed; avoids brittle string surgery. */
  const variantOfSound = (changes: { name?: string; colour?: string }) => productPage({
    name: changes.name ?? "Acme Sound 1",
    gtin: "4006381330000",
    mpn: "ACME-S1",
    sku: "LOCAL-1",
    attributes: [{ name: "colour", value: changes.colour ?? "blue" }],
  });
  const SECOND_SHOP: PermittedSource = {
    retailerName: "Second Shop",
    baseUrl: "https://other.example.test",
    hosts: ["other.example.test"],
  };
  const bothShops = (url: URL) => permitted(url) ?? (url.hostname === "other.example.test" ? SECOND_SHOP : null);

  function ingesting(page: string, now = "2026-11-19T10:00:00Z") {
    return createIngestion(db, {
      sourcePolicy: bothShops,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date(now),
      fetch: async () => new Response(page, { status: 200 }),
    });
  }

  it("merges two listings whose identifiers and configuration agree, keeping each retailer's SKU local", async () => {
    const ingest = ingesting(SOUND);
    const first = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    const second = await ingest.ingestProductPage(shopper, "https://other.example.test/p/sound-1");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value.variantId).toBe(first.value.variantId);
    expect(await db("variants").count("* as count").first()).toMatchObject({ count: "1" });
    const skus = await db("offers")
      .where({ variant_id: first.value.variantId })
      .orderBy("retailer_sku")
      .pluck("retailer_sku");
    expect(skus).toEqual(["LOCAL-1", "LOCAL-1"]);
    const retailerSkus = await db("offers")
      .join("retailers", "retailers.id", "offers.retailer_id")
      .orderBy("retailers.name")
      .select("retailers.name as retailer", "offers.retailer_sku");
    expect(retailerSkus).toEqual([
      { retailer: "Example Shop", retailer_sku: "LOCAL-1" },
      { retailer: "Second Shop", retailer_sku: "LOCAL-1" },
    ]);
  });

  it("keeps a configuration conflict visible and leaves the existing variant untouched", async () => {
    const ingest = ingesting(SOUND);
    const first = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const variantBefore = await db("variants").where({ id: first.value.variantId }).first();

    const red = await ingesting(variantOfSound({ colour: "red" }))
      .ingestProductPage(shopper, "https://other.example.test/p/sound-red");
    expect(red).toMatchObject({ ok: false, error: { kind: "identity-conflict", identifier: "4006381330000" } });

    expect(await db("variants").where({ id: first.value.variantId }).first()).toMatchObject({
      attributes: variantBefore.attributes,
      gtin: "4006381330000",
    });
    const conflict = await db("source_claims")
      .where({ field: "attribute.colour", mapping_status: "unresolved" })
      .whereNotNull("variant_id")
      .first();
    expect(conflict).toMatchObject({ variant_id: first.value.variantId, value: "red" });
    const reviews = await db("source_claims")
      .join("source_evidence", "source_evidence.id", "source_claims.evidence_id")
      .where({ "source_claims.mapping_status": "unresolved" })
      .select("source_evidence.source_url");
    expect(reviews).toContainEqual({ source_url: "https://other.example.test/p/sound-red" });
  });

  it("refuses to merge when the same GTIN is described as a different product", async () => {
    const ingest = ingesting(SOUND);
    expect((await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1")).ok).toBe(true);

    const impostor = await ingesting(variantOfSound({ name: "Acme Sound 2 Pro" }))
      .ingestProductPage(shopper, "https://other.example.test/p/not-the-same");

    expect(impostor).toMatchObject({ ok: false, error: { kind: "identity-conflict" } });
    expect(await db("variants").count("* as count").first()).toMatchObject({ count: "1" });
  });

  it("records an identifier conflict as a source failure so the ambiguity stays visible", async () => {
    const ingest = ingesting(SOUND);
    await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    await ingesting(variantOfSound({ colour: "red" }))
      .ingestProductPage(shopper, "https://other.example.test/p/sound-red");

    expect(await db("ingestion_sources").where({ host: "other.example.test" }).first()).toMatchObject({
      last_failure_classification: "identity",
    });
  });

  it("never merges listings that carry no reliable identifier", async () => {
    const nameless = productPage({ name: "Acme Lamp", sku: "LAMP-1", attributes: [{ name: "colour", value: "blue" }] });
    const ingest = ingesting(nameless);
    const first = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/lamp-1");
    const second = await ingest.ingestProductPage(shopper, "https://other.example.test/p/lamp-1");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // Same name, same SKU, same colour — still two variants, because a retailer
    // SKU is retailer-local and cannot establish identity.
    expect(second.value.variantId).not.toBe(first.value.variantId);
    expect(await db("variants").count("* as count").first()).toMatchObject({ count: "2" });
  });

  it("marks a listing with two GTIN identifiers as ambiguous instead of choosing one", async () => {
    const ambiguous = productPage({
      name: "Acme Sound 1",
      gtin: "4006381330000",
      sku: "LOCAL-1",
    }).replace('"gtin13":"4006381330000"', '"gtin13":"4006381330000","gtin":"8712345670009"');
    const result = await ingesting(ambiguous).ingestProductPage(shopper, "https://shop.example.test/products/ambiguous");

    expect(result).toMatchObject({ ok: false, error: { kind: "extraction-failed" } });
    expect(await db("variants").count("* as count").first()).toMatchObject({ count: "0" });
    expect(await db("ingestion_sources").where({ host: "shop.example.test" }).first()).toMatchObject({
      last_failure_classification: "extraction",
    });
  });
});

describe("source coverage for a submitted page", () => {
  function reporting(ingestion: IngestionDependencies) {
    const shopping = createShoppingCore({
      db,
      ingestion,
      models: {
        cipher: createSecretCipher({ key: "ingestion-hardening-test-secret" }),
        probe: async () => {
          throw new Error("ingestion never probes a model");
        },
      },
    });
    return shopping.catalogue.reportSourceCoverage.bind(shopping.catalogue);
  }

  const fetched = (page: string, at = "2026-11-19T10:00:00Z"): IngestionDependencies => ({
    sourcePolicy: permitted,
    resolve: async () => [PUBLIC_ADDRESS],
    now: () => new Date(at),
    fetch: async () => new Response(page, { status: 200 }),
  });

  it("reports what a successful extraction covered, including unfamiliar claims", async () => {
    const report = reporting(fetched(BLUE_SOUND));
    const result = await report(shopper, "https://shop.example.test/products/sound-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      sourceUrl: "https://shop.example.test/products/sound-1",
      finalUrl: "https://shop.example.test/products/sound-1",
      retailerName: "Example Shop",
      outcome: "extracted",
      fields: {
        name: true,
        price: true,
        currency: true,
        identifier: "gtin",
        retailerSku: "LOCAL-1",
        seller: "Example Shop",
      },
      attributes: { declared: 1, accepted: 1, unresolved: 0, unknown: [] },
    });
    // A report inspects the page; it admits nothing, so no success is recorded.
    expect(result.value.lastSuccessAt).toBeNull();
  });

  it("reports the stored last success of a source that has been ingested from", async () => {
    const shopping = createShoppingCore({
      db,
      ingestion: fetched(BLUE_SOUND),
      models: {
        cipher: createSecretCipher({ key: "ingestion-hardening-test-secret" }),
        probe: async () => {
          throw new Error("ingestion never probes a model");
        },
      },
    });
    expect((await shopping.catalogue.ingestProductPage(shopper, "https://shop.example.test/products/sound-1")).ok).toBe(true);

    const result = await shopping.catalogue.reportSourceCoverage(shopper, "https://shop.example.test/products/sound-1");

    expect(result.ok && result.value).toMatchObject({
      outcome: "extracted",
      lastSuccessAt: "2026-11-19T10:00:00.000Z",
      lastFailureAt: null,
      lastFailureClassification: null,
    });
  });

  it("names the claims the canonical vocabulary could not accept", async () => {
    const page = productPage({
      name: "Acme Sound 1",
      gtin: "4006381330000",
      attributes: [{ name: "colour", value: "blue" }, { name: "mystery power", value: "90" }],
    });
    const result = await reporting(fetched(page))(shopper, "https://shop.example.test/products/sound-1");

    expect(result.ok && result.value.attributes).toMatchObject({
      declared: 2,
      accepted: 1,
      unresolved: 1,
      unknown: ["mystery power"],
    });
  });

  it("reports a blocked page as a failed check without pretending anything was extracted", async () => {
    const report = reporting({
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date("2026-11-19T11:00:00Z"),
      fetch: async () => new Response("<html>Access Denied</html>", { status: 200 }),
    });
    const result = await report(shopper, "https://shop.example.test/products/sound-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      outcome: "challenge",
      fields: { name: false, price: false, currency: false, identifier: null, retailerSku: null, seller: null },
      attributes: { declared: 0, accepted: 0, unresolved: 0, unknown: [] },
      lastSuccessAt: null,
      lastFailureAt: "2026-11-19T11:00:00.000Z",
      lastFailureClassification: "challenge",
    });
  });

  it("refuses an unsafe URL instead of reporting on it", async () => {
    const result = await reporting(fetched(BLUE_SOUND))(shopper, "https://127.0.0.1/private");

    expect(result).toMatchObject({ ok: false, error: { kind: "unsafe-url" } });
  });

  it("is not available to an anonymous caller", async () => {
    const result = await reporting(fetched(BLUE_SOUND))(anonymous, "https://shop.example.test/products/sound-1");

    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden", capability: "catalogue.ingest" } });
  });
});

describe("re-ingesting the same page is idempotent", () => {
  it("returns the same identities and writes no duplicate rows", async () => {
    let observedAt = "2026-11-19T10:00:00Z";
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now: () => new Date(observedAt),
      fetch: async () => new Response(BLUE_SOUND, { status: 200 }),
    });

    const first = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    observedAt = "2026-11-20T10:00:00Z";
    const second = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");

    // Same identities, even though the second check observed at a later time.
    expect(second).toEqual(first);
    for (const table of ["products", "variants", "retailers", "offers", "source_evidence", "price_observations"]) {
      expect(await db(table).count("* as count").first(), table).toMatchObject({ count: "1" });
    }
    expect(await db("source_claims").count("* as count").first()).toMatchObject({ count: "4" });
    if (!second.ok) return;
    // The observation was replaced in place, so the newest check is what remains.
    expect(await db("price_observations").where({ offer_id: second.value.offerId }).first()).toMatchObject({
      amount: "99.95",
    });
    const observed = await db("price_observations").where({ offer_id: second.value.offerId }).first();
    expect(new Date(observed.observed_at).toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });
});

describe("a failed extraction never overwrites valid observations", () => {
  it("keeps the accepted price observation, attributes and claims when a later extraction fails", async () => {
    const now = () => new Date(observedAt);
    let observedAt = "2026-11-19T10:00:00Z";
    let page = BLUE_SOUND;
    const ingest = createIngestion(db, {
      sourcePolicy: permitted,
      resolve: async () => [PUBLIC_ADDRESS],
      now,
      fetch: async () => new Response(page, { status: 200 }),
    });

    const first = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const detail = await core({ sourcePolicy: permitted }).catalogue.getVariantOfferDetail(anonymous, first.value.variantId);
    expect(detail.ok && detail.value.variant.attributes).toMatchObject({ colour: "blue" });
    expect(detail.ok && detail.value.offers[0]?.currentPrice?.amount).toBe("99.95");
    const claimsBefore = await db("source_claims").where({ evidence_id: first.value.evidenceId }).orderBy("field");

    // A layout change drops the price, then the whole structured block.
    observedAt = "2026-11-20T10:00:00Z";
    page = productPage({
      name: "Acme Sound 1",
      gtin: "4006381330000",
      mpn: "ACME-S1",
      sku: "LOCAL-1",
      attributes: [{ name: "colour", value: "blue" }],
    }).replace('"price":"99.95",', "");
    const priceGone = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    expect(priceGone).toMatchObject({ ok: false, error: { kind: "extraction-failed" } });
    page = "<html><body>Our new shop layout</body></html>";
    const blockGone = await ingest.ingestProductPage(shopper, "https://shop.example.test/products/sound-1");
    expect(blockGone).toMatchObject({ ok: false, error: { kind: "extraction-failed" } });

    const after = await core({ sourcePolicy: permitted }).catalogue.getVariantOfferDetail(anonymous, first.value.variantId);
    expect(after.ok && after.value.variant.attributes).toMatchObject({ colour: "blue" });
    expect(after.ok && after.value.offers[0]?.currentPrice).toMatchObject({
      amount: "99.95",
      observedAt: "2026-11-19T10:00:00.000Z",
    });
    expect(await db("source_claims").where({ evidence_id: first.value.evidenceId }).orderBy("field")).toEqual(claimsBefore);
    expect(await db("price_observations").count("* as count").first()).toMatchObject({ count: "1" });
  });
});
