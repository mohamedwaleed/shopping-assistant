/**
 * The evidence store (#57): products, exact variants, retailer offers, and the
 * stated facts behind each one.
 *
 * A source page may describe a product, one exact configuration of it, and one
 * retailer's offer. The four tables keep those concepts separate so that
 * ranking, comparison, and freshness never conflate a configuration with the
 * model line that contains it:
 *
 * - `products` is the model line a shopper compares across shops;
 * - `variants` is an exact configuration (one fingerprint per line, and the
 *   fingerprint is chosen conservatively: a page with no identifier is never
 *   merged with another on name alone);
 * - `offers` is one retailer's offer for one variant at one purchase URL, and
 *   its `checked_at` is when the page was last read;
 * - `facts` is the evidence: every stated fact, naming its field, its value,
 *   the page it came from, and exactly one of the three targets it belongs to.
 *
 * Images have no table of their own; an available image is a variant-level
 * fact and also sits in the variant's `attrs`, so a card can read it without
 * joining.
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  await knex.schema.createTable("products", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    // The name is required because the product line is matched by it; a page
    // that states no name falls back to its title.
    table.text("name").notNullable();
    table.text("brand");
    table.text("category");
    table.text("description");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("variants", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("product_id")
      .notNullable()
      .references("id")
      .inTable("products")
      .onDelete("CASCADE");
    table.text("fingerprint").notNullable();
    // The stated configuration attributes, so the exact variant is inspectable
    // without joining its evidence.
    table.jsonb("attrs").notNullable().defaultTo("{}");
    table.unique(["product_id", "fingerprint"]);
  });

  await knex.schema.createTable("offers", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("variant_id")
      .notNullable()
      .references("id")
      .inTable("variants")
      .onDelete("CASCADE");
    table.text("retailer").notNullable();
    table.text("purchase_url").notNullable();
    // Null means the page did not state the value, which is a fact a shopper
    // can act on; a missing price must never read as zero.
    table.integer("price_cents");
    table.specificType("currency", "char(3)");
    table.text("availability");
    table.text("condition");
    table.timestamp("checked_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(["variant_id", "checked_at"], "offers_variant");
  });

  await knex.schema.createTable("facts", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("offer_id").references("id").inTable("offers").onDelete("CASCADE");
    table.uuid("variant_id").references("id").inTable("variants").onDelete("CASCADE");
    table.uuid("product_id").references("id").inTable("products").onDelete("CASCADE");
    table.text("field").notNullable();
    table.text("value").notNullable();
    table.text("source_url").notNullable();
    table.timestamp("check_time", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    // A fact belongs to exactly one target; `num_nonnulls` counts the
    // non-null target columns, so all three present or none is refused.
    table.check("num_nonnulls(offer_id, variant_id, product_id) = 1");
    table.index(["offer_id"], "facts_offer");
    table.index(["variant_id"], "facts_variant");
    table.index(["product_id"], "facts_product");
  });
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("facts");
  await knex.schema.dropTableIfExists("offers");
  await knex.schema.dropTableIfExists("variants");
  await knex.schema.dropTableIfExists("products");
}