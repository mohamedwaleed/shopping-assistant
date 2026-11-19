// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/** Authenticator secrets and recovery-code hashes; codes are deleted on use. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("two_factor_authenticator", (t) => {
    t.text("user_id").primary().references("id").inTable("user").onDelete("CASCADE");
    t.text("secret").notNullable();
    t.boolean("enabled").notNullable().defaultTo(false);
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("two_factor_backup_code", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("user_id").notNullable().references("id").inTable("user").onDelete("CASCADE");
    t.text("code_hash").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(["user_id", "code_hash"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("two_factor_backup_code").dropTableIfExists("two_factor_authenticator");
}
