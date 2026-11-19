// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/** Evidence is append-safe public catalogue data; it never stores a shopper URL or prompt. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("offers", (t) => {
    t.text("retailer_sku");
    t.text("seller_name");
    t.unique(["retailer_id", "url"], { indexName: "offers_retailer_url_unique" });
  });

  await knex.schema.createTable("source_evidence", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("source_url").notNullable().unique();
    t.text("final_url").notNullable();
    t.text("excerpt").notNullable();
    t.timestamp("source_published_at", { useTz: true });
    t.timestamp("observed_at", { useTz: true }).notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("source_claims", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("evidence_id").notNullable().references("id").inTable("source_evidence").onDelete("CASCADE");
    t.uuid("product_id").references("id").inTable("products").onDelete("CASCADE");
    t.uuid("variant_id").references("id").inTable("variants").onDelete("CASCADE");
    t.uuid("offer_id").references("id").inTable("offers").onDelete("CASCADE");
    t.text("field").notNullable();
    t.jsonb("value").notNullable();
    t.timestamp("observed_at", { useTz: true }).notNullable();
    t.unique(["evidence_id", "field"], { indexName: "source_claims_evidence_field_unique" });
  });
  await knex.raw(
    "ALTER TABLE source_claims ADD CONSTRAINT source_claims_target_check " +
      "CHECK (num_nonnulls(product_id, variant_id, offer_id) = 1)",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("source_claims").dropTableIfExists("source_evidence");
  await knex.schema.alterTable("offers", (t) => {
    t.dropUnique(["retailer_id", "url"], "offers_retailer_url_unique");
    t.dropColumns("retailer_sku", "seller_name");
  });
}
