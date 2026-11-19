// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// Model configuration for the shared registry: one installation default and
// per-workspace overrides. Credentials are stored encrypted (AES-256-GCM with
// an installation secret held outside PostgreSQL, docs/adr/0012) and only ever
// surface as a masked hint; usage_source records which account pays.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("installation_model_settings", (t) => {
    t.integer("id").primary().defaultTo(1);
    t.text("default_model");
    t.text("extraction_model");
    t.text("usage_source");
    t.timestamp("capability_tested_at", { useTz: true });
    t.jsonb("capability_report");
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE installation_model_settings ADD CONSTRAINT installation_model_settings_singleton_check " +
      "CHECK (id = 1)",
  );
  await knex.raw(
    "ALTER TABLE installation_model_settings ADD CONSTRAINT installation_model_settings_usage_source_check " +
      "CHECK (usage_source IS NULL OR usage_source IN ('installation', 'workspace'))",
  );
  await knex.raw(
    "INSERT INTO installation_model_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
  );

  await knex.schema.createTable("installation_model_credentials", (t) => {
    t.integer("id").primary().defaultTo(1);
    t.text("provider").notNullable();
    t.text("ciphertext").notNullable();
    t.text("encryption").notNullable();
    t.text("masked_hint").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE installation_model_credentials ADD CONSTRAINT installation_model_credentials_singleton_check " +
      "CHECK (id = 1)",
  );

  await knex.schema.createTable("workspace_model_settings", (t) => {
    t.uuid("workspace_id")
      .primary()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    t.text("default_model");
    t.text("extraction_model");
    t.text("usage_source");
    t.timestamp("capability_tested_at", { useTz: true });
    t.jsonb("capability_report");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE workspace_model_settings ADD CONSTRAINT workspace_model_settings_usage_source_check " +
      "CHECK (usage_source IS NULL OR usage_source IN ('installation', 'workspace'))",
  );

  await knex.schema.createTable("workspace_model_credentials", (t) => {
    t.uuid("workspace_id")
      .primary()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    t.text("provider").notNullable();
    t.text("ciphertext").notNullable();
    t.text("encryption").notNullable();
    t.text("masked_hint").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("workspace_model_credentials")
    .dropTableIfExists("workspace_model_settings")
    .dropTableIfExists("installation_model_credentials")
    .dropTableIfExists("installation_model_settings");
}
