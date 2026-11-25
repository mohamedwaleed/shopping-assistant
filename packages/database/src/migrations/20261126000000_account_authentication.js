/**
 * Hands identity to Better Auth (#52). Better Auth owns the `user` table and the
 * credential, session, and verification rows behind it. The installation's own
 * account record keeps its role and stays the owner of private data, so it is
 * renamed to `profiles` and follows the Better Auth user by its id.
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  // Better Auth's core schema. Column names are its camelCase field names; the
  // adapter maps models and fields, so no `modelName` overrides are needed.
  await knex.schema.createTable("user", (table) => {
    // Better Auth ids are opaque strings it generates itself. The default keeps
    // SQL-created rows (fixtures, the bootstrap) in the same uuid format.
    table.text("id").primary().defaultTo(knex.raw("gen_random_uuid()::text"));
    table.text("name").notNullable();
    table.text("email").notNullable().unique();
    table.boolean("emailVerified").notNullable().defaultTo(false);
    table.text("image");
    table.timestamp("createdAt", { useTz: true }).notNullable();
    table.timestamp("updatedAt", { useTz: true }).notNullable();
  });

  await knex.schema.createTable("session", (table) => {
    table.text("id").primary().defaultTo(knex.raw("gen_random_uuid()::text"));
    table.timestamp("expiresAt", { useTz: true }).notNullable();
    table.text("token").notNullable().unique();
    table.timestamp("createdAt", { useTz: true }).notNullable();
    table.timestamp("updatedAt", { useTz: true }).notNullable();
    table.text("ipAddress");
    table.text("userAgent");
    table
      .text("userId")
      .notNullable()
      .references("id")
      .inTable("user")
      .onDelete("CASCADE");
    table.index(["userId"], "session_userId_index");
  });

  // One row per authentication method. Email/password accounts are the
  // `credential` provider and hold the password hash here, never on `user`.
  await knex.schema.createTable("account", (table) => {
    table.text("id").primary().defaultTo(knex.raw("gen_random_uuid()::text"));
    table.text("accountId").notNullable();
    table.text("providerId").notNullable();
    table
      .text("userId")
      .notNullable()
      .references("id")
      .inTable("user")
      .onDelete("CASCADE");
    table.text("accessToken");
    table.text("refreshToken");
    table.text("idToken");
    table.timestamp("accessTokenExpiresAt", { useTz: true });
    table.timestamp("refreshTokenExpiresAt", { useTz: true });
    table.text("scope");
    table.text("password");
    table.timestamp("createdAt", { useTz: true }).notNullable();
    table.timestamp("updatedAt", { useTz: true }).notNullable();
    table.index(["userId"], "account_userId_index");
  });

  await knex.schema.createTable("verification", (table) => {
    table.text("id").primary().defaultTo(knex.raw("gen_random_uuid()::text"));
    table.text("identifier").notNullable();
    table.text("value").notNullable();
    table.timestamp("expiresAt", { useTz: true }).notNullable();
    table.timestamp("createdAt", { useTz: true }).notNullable();
    table.timestamp("updatedAt", { useTz: true }).notNullable();
    table.index(["identifier"], "verification_identifier_index");
  });

  // Existing accounts were created before Better Auth owned identity, so they
  // get a Better Auth user row first, keeping the same id so that every
  // reference below still resolves.
  await knex.raw(`
    INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    SELECT id::text, split_part(email, '@', 1), email, false, created_at, created_at
    FROM users
  `);
  await knex.schema.renameTable("users", "profiles");
  // Profiles carry no password of their own: Better Auth's `account` table does.
  // Widening a uuid column would rewrite it, so the dependent keys are dropped
  // for the length of the change and re-added afterwards.
  await knex.raw(`
    ALTER TABLE conversations DROP CONSTRAINT conversations_user_id_foreign;
    ALTER TABLE installation DROP CONSTRAINT installation_initial_admin_id_foreign;
    ALTER TABLE profiles
      ALTER COLUMN id TYPE text USING id::text,
      ALTER COLUMN id DROP DEFAULT;
    ALTER TABLE conversations ALTER COLUMN user_id TYPE text USING user_id::text;
    ALTER TABLE installation ALTER COLUMN initial_admin_id TYPE text USING initial_admin_id::text;
    ALTER TABLE profiles
      ADD CONSTRAINT profiles_id_foreign
        FOREIGN KEY (id) REFERENCES "user" (id) ON DELETE CASCADE;
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_user_id_foreign
        FOREIGN KEY (user_id) REFERENCES profiles (id) ON DELETE CASCADE;
    ALTER TABLE installation
      ADD CONSTRAINT installation_initial_admin_id_foreign
        FOREIGN KEY (initial_admin_id) REFERENCES profiles (id) ON DELETE SET NULL
        DEFERRABLE INITIALLY IMMEDIATE;
  `);

  // Public registration is installation policy (#54 toggles it), so it lives
  // beside the bootstrap record rather than in process configuration.
  await knex.schema.alterTable("installation", (table) => {
    table.boolean("registration_open").notNullable().defaultTo(true);
  });
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable("installation", (table) => {
    table.dropColumn("registration_open");
  });
  // Dependents lose their keys first, the profile narrows back to a uuid, and
  // only then can the keys be restored against the narrowed column.
  await knex.raw(`
    ALTER TABLE installation DROP CONSTRAINT installation_initial_admin_id_foreign;
    ALTER TABLE conversations DROP CONSTRAINT conversations_user_id_foreign;
    ALTER TABLE profiles
      DROP CONSTRAINT profiles_id_foreign,
      ALTER COLUMN id TYPE uuid USING id::uuid,
      ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE conversations ALTER COLUMN user_id TYPE uuid USING user_id::uuid;
    ALTER TABLE installation ALTER COLUMN initial_admin_id TYPE uuid USING initial_admin_id::uuid;
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_user_id_foreign
        FOREIGN KEY (user_id) REFERENCES profiles (id) ON DELETE CASCADE;
    ALTER TABLE installation
      ADD CONSTRAINT installation_initial_admin_id_foreign
        FOREIGN KEY (initial_admin_id) REFERENCES profiles (id) ON DELETE SET NULL
        DEFERRABLE INITIALLY IMMEDIATE;
  `);
  await knex.schema.renameTable("profiles", "users");
  await knex.schema.dropTableIfExists("verification");
  await knex.schema.dropTableIfExists("account");
  await knex.schema.dropTableIfExists("session");
  await knex.schema.dropTableIfExists("user");
}
