/**
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  // A requirement's kind is fixed by the shopper's own statement, so a stored
  // requirement is never reclassified by research or by the assistant.
  await knex.raw(`CREATE TYPE requirement_kind AS ENUM ('hard_constraint', 'preference')`);

  await knex.schema.createTable("requirements", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("conversation_id")
      .notNullable()
      .references("id")
      .inTable("conversations")
      .onDelete("CASCADE");
    table.specificType("kind", "requirement_kind").notNullable();
    table.text("statement").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Requirements saved in one statement share a timestamp, so the order the
    // shopper stated them in needs a monotonic key a random UUID cannot provide.
    table.bigIncrements("seq").notNullable();
    // Rewriting the same requirement updates it instead of duplicating it.
    table.unique(["conversation_id", "kind", "statement"]);
    table.index(["conversation_id", "kind"], "requirements_conversation_id_kind_index");
  });
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("requirements");
  await knex.raw(`DROP TYPE IF EXISTS requirement_kind`);
}
