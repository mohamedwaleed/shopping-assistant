// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/** Durable provider spending reservations. Amounts are integer euro cents. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("installation_provider_budget_settings", (t) => {
    t.integer("id").primary().defaultTo(1);
    t.integer("interactive_cents").notNullable().defaultTo(0);
    t.integer("background_cents").notNullable().defaultTo(0);
    t.integer("max_interactive").notNullable().defaultTo(1);
    t.integer("max_background").notNullable().defaultTo(1);
    t.integer("retry_limit").notNullable().defaultTo(0);
    t.boolean("paid_fallback_enabled").notNullable().defaultTo(false);
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE installation_provider_budget_settings ADD CONSTRAINT installation_provider_budget_singleton CHECK (id = 1)");
  await knex.raw("INSERT INTO installation_provider_budget_settings (id) VALUES (1)");
  await knex.schema.createTable("workspace_provider_budget_settings", (t) => {
    t.uuid("workspace_id").primary().references("id").inTable("workspaces").onDelete("CASCADE");
    t.integer("interactive_cents").notNullable().defaultTo(0);
    t.integer("background_cents").notNullable().defaultTo(0);
    t.boolean("background_personal_key_consent").notNullable().defaultTo(false);
    t.boolean("paid_fallback_enabled").notNullable().defaultTo(false);
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("workspace_provider_budget_usage", (t) => {
    t.uuid("workspace_id").references("id").inTable("workspaces").onDelete("CASCADE");
    t.text("kind").notNullable();
    t.integer("settled_cents").notNullable().defaultTo(0);
    t.integer("reserved_cents").notNullable().defaultTo(0);
    t.primary(["workspace_id", "kind"]);
  });
  await knex.schema.createTable("provider_budget_reservations", (t) => {
    t.uuid("id").primary();
    t.uuid("workspace_id").notNullable().references("id").inTable("workspaces").onDelete("CASCADE");
    t.text("kind").notNullable();
    t.text("usage_source").notNullable();
    t.integer("estimated_cents").notNullable();
    t.integer("attempts").notNullable().defaultTo(0);
    t.text("state").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE provider_budget_reservations ADD CONSTRAINT provider_budget_reservation_state CHECK (state IN ('reserved', 'settled', 'cancelled'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("provider_budget_reservations").dropTableIfExists("workspace_provider_budget_usage").dropTableIfExists("workspace_provider_budget_settings").dropTableIfExists("installation_provider_budget_settings");
}
