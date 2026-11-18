// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// Identity (Better Auth tables, owned by Knex migrations rather than library
// migrations), private workspace ownership and installation state. Private
// shopper data stays in the workspace scope; see docs/adr/0001 and 0009.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("user", (t) => {
    t.text("id").primary();
    t.text("name").notNullable();
    t.text("email").notNullable().unique();
    t.boolean("email_verified").notNullable().defaultTo(false);
    t.text("image");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("session", (t) => {
    t.text("id").primary();
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.text("token").notNullable().unique();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text("ip_address");
    t.text("user_agent");
    t.text("user_id").notNullable().references("id").inTable("user").onDelete("CASCADE");
    t.index(["user_id"], "session_user_id_idx");
  });

  await knex.schema.createTable("account", (t) => {
    t.text("id").primary();
    t.text("account_id").notNullable();
    t.text("provider_id").notNullable();
    t.text("user_id").notNullable().references("id").inTable("user").onDelete("CASCADE");
    t.text("access_token");
    t.text("refresh_token");
    t.text("id_token");
    t.timestamp("access_token_expires_at", { useTz: true });
    t.timestamp("refresh_token_expires_at", { useTz: true });
    t.text("scope");
    t.text("password");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["user_id"], "account_user_id_idx");
  });

  await knex.schema.createTable("verification", (t) => {
    t.text("id").primary();
    t.text("identifier").notNullable();
    t.text("value").notNullable();
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["identifier"], "verification_identifier_idx");
  });

  await knex.schema.createTable("workspaces", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("name").notNullable();
    t.text("created_by_user_id")
      .notNullable()
      .references("id")
      .inTable("user")
      .onDelete("CASCADE");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Initially one private workspace per user; shared workspaces are future scope.
  await knex.schema.createTable("workspace_memberships", (t) => {
    t.uuid("workspace_id").notNullable().references("id").inTable("workspaces").onDelete("CASCADE");
    t.text("user_id").notNullable().references("id").inTable("user").onDelete("CASCADE");
    t.text("role").notNullable().defaultTo("owner");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(["workspace_id", "user_id"]);
    t.index(["user_id"], "workspace_memberships_user_id_idx");
  });
  await knex.raw(
    "ALTER TABLE workspace_memberships ADD CONSTRAINT workspace_memberships_role_check " +
      "CHECK (role IN ('owner', 'member'))",
  );
  await knex.raw(
    "CREATE UNIQUE INDEX workspace_memberships_single_owner_idx " +
      "ON workspace_memberships (workspace_id) WHERE role = 'owner'",
  );

  // One row per self-hosted installation. A single row is enforced by the
  // primary key so setup can only be claimed once.
  await knex.schema.createTable("installation", (t) => {
    t.integer("id").primary().defaultTo(1);
    t.timestamp("setup_completed_at", { useTz: true });
    t.text("setup_token_hash");
    t.text("setup_administrator_user_id").references("id").inTable("user").onDelete("SET NULL");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw("ALTER TABLE installation ADD CONSTRAINT installation_singleton_check CHECK (id = 1)");
  await knex.raw(
    "INSERT INTO installation (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("installation")
    .dropTableIfExists("workspace_memberships")
    .dropTableIfExists("workspaces")
    .dropTableIfExists("verification")
    .dropTableIfExists("account")
    .dropTableIfExists("session")
    .dropTableIfExists("user");
}
