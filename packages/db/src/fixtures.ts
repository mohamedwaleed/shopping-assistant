// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/**
 * Development fixtures are fixed-UUID rows flagged is_development_fixture so
 * the UI can label them and cleanup stays trivial. They are inserted only by
 * explicit request (LOAD_DEV_FIXTURES / `pnpm db:fixtures`), never by schema
 * migrations, keeping fixtures separate from live data.
 */
export const DEVELOPMENT_FIXTURE_IDS = {
  productId: "a0000000-0000-4000-8000-000000000010",
  retailerId: "a0000000-0000-4000-8000-000000000020",
  variantId: "a0000000-0000-4000-8000-000000000030",
  offerId: "a0000000-0000-4000-8000-000000000040",
  observationId: "a0000000-0000-4000-8000-000000000050",
} as const;

export async function loadDevelopmentFixtures(db: Knex): Promise<void> {
  const ids = DEVELOPMENT_FIXTURE_IDS;

  await db("products")
    .insert({
      id: ids.productId,
      name: "Dell UltraSharp U2723QE",
      manufacturer: "Dell",
      category: "monitors",
      is_development_fixture: true,
    })
    .onConflict("id")
    .ignore();

  await db("retailers")
    .insert({
      id: ids.retailerId,
      name: "Coolblue",
      base_url: "https://www.coolblue.nl",
      is_development_fixture: true,
    })
    .onConflict("id")
    .ignore();

  await db("variants")
    .insert({
      id: ids.variantId,
      product_id: ids.productId,
      name: "27-inch 4K USB-C, 90 W power delivery",
      gtin: "5397184572244",
      manufacturer_part_number: "U2723QE",
      attributes: {
        screen_size_inch: 27,
        resolution: "3840x2160",
        panel: "IPS Black",
        usb_c_power_delivery_w: 90,
      },
      is_development_fixture: true,
    })
    .onConflict("id")
    .ignore();

  await db("offers")
    .insert({
      id: ids.offerId,
      variant_id: ids.variantId,
      retailer_id: ids.retailerId,
      url: "https://www.coolblue.nl/product/869952/dell-ultrasharp-u2723qe.html",
      condition: "new",
      is_development_fixture: true,
    })
    .onConflict("id")
    .ignore();

  await db("price_observations")
    .insert({
      id: ids.observationId,
      offer_id: ids.offerId,
      amount: "559.00",
      currency: "EUR",
      shipping_amount: "0.00",
      vat_included: true,
      source_kind: "development_fixture",
      is_development_fixture: true,
      observed_at: db.fn.now(),
    })
    .onConflict("id")
    .ignore();
}
