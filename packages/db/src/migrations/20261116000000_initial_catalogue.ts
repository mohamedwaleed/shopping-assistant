// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// Public catalogue facts only. Private workspace data lands in its own scope;
// see docs/adr/0003-public-catalogue-private-workspaces.md.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("products", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("name").notNullable();
    t.text("manufacturer");
    t.text("category");
    t.boolean("is_development_fixture").notNullable().defaultTo(false);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("retailers", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("name").notNullable();
    t.text("base_url").notNullable();
    t.boolean("is_development_fixture").notNullable().defaultTo(false);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("variants", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("product_id").notNullable().references("id").inTable("products").onDelete("CASCADE");
    t.text("name").notNullable();
    t.text("gtin");
    t.text("manufacturer_part_number");
    t.jsonb("attributes").notNullable().defaultTo("{}");
    t.boolean("is_development_fixture").notNullable().defaultTo(false);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("offers", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("variant_id").notNullable().references("id").inTable("variants").onDelete("CASCADE");
    t.uuid("retailer_id").notNullable().references("id").inTable("retailers");
    t.text("url").notNullable();
    t.text("condition").notNullable().defaultTo("new");
    t.boolean("is_development_fixture").notNullable().defaultTo(false);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE offers ADD CONSTRAINT offers_condition_check " +
      "CHECK (condition IN ('new', 'refurbished'))",
  );

  await knex.schema.createTable("price_observations", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("offer_id").notNullable().references("id").inTable("offers").onDelete("CASCADE");
    t.decimal("amount", 12, 2).notNullable();
    t.specificType("currency", "char(3)").notNullable();
    t.decimal("shipping_amount", 12, 2).notNullable().defaultTo(0);
    t.boolean("vat_included").notNullable().defaultTo(true);
    t.text("source_kind").notNullable().defaultTo("retailer_page");
    t.boolean("is_development_fixture").notNullable().defaultTo(false);
    t.timestamp("observed_at", { useTz: true }).notNullable();
    t.index(["offer_id", "observed_at"], "price_observations_offer_time_idx");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("price_observations")
    .dropTableIfExists("offers")
    .dropTableIfExists("variants")
    .dropTableIfExists("retailers")
    .dropTableIfExists("products");
}
