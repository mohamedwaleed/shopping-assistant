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
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
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
