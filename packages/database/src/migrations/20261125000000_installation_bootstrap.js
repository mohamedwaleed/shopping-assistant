/**
 * Records that the installation's first admin exists, so the bootstrap flow
 * closes for good. Kept separate from `users` so that deleting every account
 * cannot reopen setup.
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable("installation", (table) => {
    // At most one installation row; the primary key is the bootstrap guard.
    table.smallint("id").primary().defaultTo(1);
    table.check("id = 1", [], "installation_single_row");
    // Who bootstrapped, for operators; nullable so the initial admin can still
    // be deleted later without reopening setup.
    table
      .uuid("initial_admin_id")
      .references("id")
      .inTable("users")
      .onDelete("SET NULL");
    table.timestamp("initial_admin_created_at", { useTz: true }).notNullable();
  });
  // The installation record is inserted before the admin it names, inside one
  // transaction, so the reference is checked when that transaction commits.
  await knex.raw(`
    ALTER TABLE installation
    DROP CONSTRAINT installation_initial_admin_id_foreign,
    ADD CONSTRAINT installation_initial_admin_id_foreign
      FOREIGN KEY (initial_admin_id) REFERENCES users (id) ON DELETE SET NULL
      DEFERRABLE INITIALLY IMMEDIATE
  `);
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("installation");
}
