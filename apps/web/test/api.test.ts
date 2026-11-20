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

// Thin-adapter contract checks: the HTTP layer maps core results and errors.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

let db: Knex;
let variantRoute: typeof import("../app/api/catalogue/variants/[id]/route");
let healthRoute: typeof import("../app/api/health/route");

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  // The core wires the model registry; its credential cipher needs the
  // installation secret the development stack supplies.
  process.env.INSTALLATION_SECRET = "api-contract-installation-secret-0123";
  db = createDb(TEST_DATABASE_URL);
  await migrateFresh(db);
  await loadDevelopmentFixtures(db);
  variantRoute = await import("../app/api/catalogue/variants/[id]/route");
  healthRoute = await import("../app/api/health/route");
});

afterAll(async () => {
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

function getVariant(id: string) {
  return variantRoute.GET(
    new Request(`http://localhost/api/catalogue/variants/${id}`),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/catalogue/variants/:id", () => {
  it("returns the variant, offer and delivered-price detail", async () => {
    const res = await getVariant(DEVELOPMENT_FIXTURE_IDS.variantId);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.variant.product.name).toBe("Dell UltraSharp U2723QE");
    expect(body.variant.product.isDevelopmentFixture).toBe(true);
    expect(body.offers[0].retailer.name).toBe("Coolblue");
    expect(body.offers[0].currentPrice.amount).toBe("559.00");
    expect(body.offers[0].currentPrice.deliveredAmount).toBe("559.00");
    expect(body.offers[0].currentPrice.currency).toBe("EUR");
  });

  it("maps malformed identifiers to 400", async () => {
    const res = await getVariant("not-a-uuid");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.kind).toBe("invalid-input");
  });

  it("maps unknown variants to 404", async () => {
    const res = await getVariant("00000000-0000-4000-8000-00000000dead");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.kind).toBe("not-found");
  });
});

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const res = await healthRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("up");
  });
});
