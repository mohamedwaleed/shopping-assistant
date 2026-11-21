// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  migrateFresh,
  createDb,
  DEFAULT_TEST_DATABASE_URL,
  DEVELOPMENT_FIXTURE_IDS,
  loadDevelopmentFixtures,
} from "@shopping/db";

// Thin-adapter contract checks: the HTTP layer parses the query string, maps
// core results, and turns core errors into status codes. Behaviour itself is
// covered at the core seam (packages/core/test/catalogue-search*).
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

let db: Knex;
let searchRoute: typeof import("../app/api/catalogue/search/route");

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.INSTALLATION_SECRET = "api-contract-installation-secret-0123";
  db = createDb(TEST_DATABASE_URL);
  await migrateFresh(db);
  await loadDevelopmentFixtures(db);
  searchRoute = await import("../app/api/catalogue/search/route");
});

afterAll(async () => {
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

function search(query: string) {
  return searchRoute.GET(new Request(`http://localhost/api/catalogue/search?${query}`));
}

describe("GET /api/catalogue/search", () => {
  it("returns cards for a model identifier", async () => {
    const res = await search("identifiers=U2723QE");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query.identifiers).toBe("U2723QE");
    expect(body.results).toHaveLength(1);
    const card = body.results[0];
    expect(card.variant.id).toBe(DEVELOPMENT_FIXTURE_IDS.variantId);
    expect(card.identifiers.manufacturerPartNumber).toBe("U2723QE");
    expect(card.offers.best.amount).toBe("559.00");
    expect(card.offers.best.currency).toBe("EUR");
    expect(card.uncertainty).toBe("verified");
    expect(card.match).toEqual({ mode: "identifier", kind: "model", value: "U2723QE" });
  });

  it("accepts repeated filter parameters", async () => {
    const res = await search("filter=colour:black&filter=power_w:gte:100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.query.filters).toEqual([
      { key: "colour", op: "eq", value: "black" },
      { key: "power_w", op: "gte", value: "100" },
    ]);
  });

  it("clamps the limit parameter", async () => {
    const res = await search("text=monitor&limit=500");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeLessThanOrEqual(50);
  });

  it("maps an empty query to 400", async () => {
    const res = await search("");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toEqual({
      kind: "invalid-input",
      field: "query",
      message: "Provide a model identifier, search text, or a filter",
    });
  });

  it("maps a malformed filter to 400 naming the parameter", async () => {
    const res = await search("filter=colour");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.kind).toBe("invalid-input");
    expect(body.error.field).toBe("filter");
  });

  it("maps an unknown attribute to 400", async () => {
    const res = await search("filter=mystery_power:90");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toEqual({
      kind: "invalid-input",
      field: "filters.mystery_power",
      message: "mystery_power is not a filterable catalogue attribute",
    });
  });

  it("returns an empty list rather than an error when nothing matches", async () => {
    const res = await search("text=tosti%20ijzer");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });
});
