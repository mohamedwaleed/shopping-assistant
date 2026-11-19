// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/** Private conversation state is workspace-owned; model summaries are never authoritative. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("shopping_sessions", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("workspace_id").notNullable().references("id").inTable("workspaces").onDelete("CASCADE");
    t.text("title").notNullable(); t.text("language").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["workspace_id", "updated_at"]);
  });
  await knex.schema.createTable("shopping_session_messages", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("session_id").notNullable().references("id").inTable("shopping_sessions").onDelete("CASCADE");
    t.text("role").notNullable(); t.text("content").notNullable(); t.jsonb("parts").notNullable().defaultTo("[]");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now()); t.index(["session_id", "created_at"]);
  });
  await knex.schema.createTable("shopping_session_requirements", (t) => {
    t.uuid("session_id").primary().references("id").inTable("shopping_sessions").onDelete("CASCADE");
    t.jsonb("must_haves").notNullable().defaultTo("[]"); t.jsonb("preferences").notNullable().defaultTo("[]");
    t.jsonb("assumptions").notNullable().defaultTo("[]"); t.jsonb("questions").notNullable().defaultTo("[]");
    t.integer("revision").notNullable().defaultTo(0); t.text("revision_note");
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}
export async function down(knex: Knex): Promise<void> { await knex.schema.dropTableIfExists("shopping_session_requirements").dropTableIfExists("shopping_session_messages").dropTableIfExists("shopping_sessions"); }
