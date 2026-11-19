// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// One table for every expiring email link the account lifecycle hands out:
// seven-day invitations, thirty-minute password resets and thirty-minute
// email-address change confirmations. Only the SHA-256 hash of a token is
// stored, so a database dump cannot be turned into a working link, and
// `consumed_at` is the single-use marker. `email` is the address the link was
// bound to, so a token minted for one address cannot be spent on another.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("account_link_tokens", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("kind").notNullable();
    t.text("token_hash").notNullable().unique();
    t.text("email").notNullable();
    t.text("user_id").references("id").inTable("user").onDelete("CASCADE");
    t.text("invited_by_user_id").references("id").inTable("user").onDelete("SET NULL");
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.timestamp("consumed_at", { useTz: true });
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["kind", "email"], "account_link_tokens_kind_email_idx");
    t.index(["user_id"], "account_link_tokens_user_id_idx");
  });
  await knex.raw(
    "ALTER TABLE account_link_tokens ADD CONSTRAINT account_link_tokens_kind_check " +
      "CHECK (kind IN ('invitation', 'password-reset', 'email-change'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("account_link_tokens");
}
