// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/** Canonical vocabulary is deliberately data, not a closed category enum. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("catalogue_attributes", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("key").notNullable().unique();
    t.text("value_type").notNullable().defaultTo("text");
    t.text("unit");
    t.boolean("is_common").notNullable().defaultTo(false);
  });
  await knex.schema.createTable("catalogue_attribute_synonyms", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("attribute_id").notNullable().references("id").inTable("catalogue_attributes").onDelete("CASCADE");
    t.text("synonym").notNullable().unique();
  });
  await knex.schema.alterTable("source_claims", (t) => {
    t.text("raw_name");
    t.uuid("canonical_attribute_id").references("id").inTable("catalogue_attributes");
    t.text("mapping_status");
  });
  await knex.schema.createTable("attribute_assessments", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("variant_id").notNullable().references("id").inTable("variants").onDelete("CASCADE");
    t.uuid("attribute_id").notNullable().references("id").inTable("catalogue_attributes").onDelete("CASCADE");
    t.timestamp("invalidated_at", { useTz: true });
  });
  await knex("catalogue_attributes").insert([
    { key: "colour", value_type: "text", is_common: true },
    { key: "power_w", value_type: "number", unit: "W", is_common: true },
    { key: "screen_size_inch", value_type: "number", unit: "in", is_common: true },
  ]);
  const power = await knex("catalogue_attributes").where({ key: "power_w" }).first();
  const screen = await knex("catalogue_attributes").where({ key: "screen_size_inch" }).first();
  await knex("catalogue_attribute_synonyms").insert([
    { attribute_id: power.id, synonym: "watt" },
    { attribute_id: power.id, synonym: "watts" },
    { attribute_id: screen.id, synonym: "screen size" },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("attribute_assessments");
  await knex.schema.alterTable("source_claims", (t) => t.dropColumns("raw_name", "canonical_attribute_id", "mapping_status"));
  await knex.schema.dropTableIfExists("catalogue_attribute_synonyms").dropTableIfExists("catalogue_attributes");
}
