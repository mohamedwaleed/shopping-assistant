/**
 * Admin invitations (#53). An invitation is the one way an installation may
 * gain an ordinary account while public registration is closed, so it is
 * recorded separately from `profiles` and from the installation's policy: the
 * policy says whether anyone may sign up, the invitation says who was asked.
 *
 * Only the digest of a token is stored. A leaked table dump therefore cannot be
 * turned back into working links, exactly as a password store keeps hashes.
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable("invitations", (table) => {
    table.text("id").primary().defaultTo(knex.raw("gen_random_uuid()::text"));
    // SHA-256 of the emailed token, hex encoded. Unique so that two invitations
    // can never be redeemed by one link.
    table.text("token_hash").notNullable().unique();
    // Stored lower-cased: the address an invitation is sent to is the only one
    // it may be accepted for, and addresses are compared case-insensitively.
    table.text("email").notNullable();
    // The admin who issued it, for operators. Deleting that admin keeps the
    // invitation usable rather than silently invalidating it.
    table
      .text("invited_by")
      .references("id")
      .inTable("profiles")
      .onDelete("SET NULL");
    table.timestamp("created_at", { useTz: true }).notNullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    // When the invitation was spent. The row is kept so a replayed link can be
    // told apart from one that never existed.
    table.timestamp("accepted_at", { useTz: true });
    // The account it produced, if any.
    table
      .text("accepted_by")
      .references("id")
      .inTable("profiles")
      .onDelete("SET NULL");
    table.index(["email"], "invitations_email_index");
  });
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("invitations");
}
