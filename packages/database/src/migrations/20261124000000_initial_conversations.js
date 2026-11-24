/**
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  await knex.raw(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  // Accounts are owned by the registration ticket (#52); this migration only
  // establishes the identity that conversations are private to.
  await knex.schema.createTable("users", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("email").notNullable().unique();
    table.text("role").notNullable().defaultTo("user");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("conversations", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("user_id")
      .notNullable()
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
    table.text("title").notNullable();
    // Ordering relies on the database clock, not the application's.
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["user_id", "created_at"], "conversations_user_id_created_at_index");
  });

  await knex.schema.createTable("messages", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("conversation_id")
      .notNullable()
      .references("id")
      .inTable("conversations")
      .onDelete("CASCADE");
    table.text("role").notNullable();
    table.text("content").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // Messages appended in one transaction share a timestamp, so insertion
    // order needs a monotonic key that a random UUID cannot provide.
    table.bigIncrements("seq").notNullable();
    table.index(["conversation_id", "seq"], "messages_conversation_id_seq_index");
  });
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("messages");
  await knex.schema.dropTableIfExists("conversations");
  await knex.schema.dropTableIfExists("users");
}
