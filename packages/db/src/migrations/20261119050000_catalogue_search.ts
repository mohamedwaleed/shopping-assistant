// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/**
 * Catalogue retrieval: exact identifiers stay exact (gtin/mpn columns with
 * pg_trgm indexes for typo tolerance), structured filters read the canonical
 * attribute vocabulary, and English/Dutch wording goes through a generated
 * `simple` tsvector plus trigram indexes. Stemming is deliberately absent: it
 * is language-specific, and "monitor"/"monitoren" or "kettle"/"ketel" are not
 * the same lexeme in any single configuration. Cross-language recall comes from
 * data instead — `catalogue_search_vocabulary` and
 * `catalogue_search_vocabulary_terms` are seeded here and extensible per
 * installation.
 */
export async function up(knex: Knex): Promise<void> {
  // pg_trgm provides similarity/word-similarity for typo tolerance and the
  // gin_trgm_ops indexes below. pgcrypto is already present for gen_random_uuid.
  await knex.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  await knex.raw(`
    ALTER TABLE variants
    ADD COLUMN search_document tsvector
    GENERATED ALWAYS AS (
      to_tsvector(
        'simple',
        coalesce(name, '') || ' ' ||
        coalesce(manufacturer_part_number, '') || ' ' ||
        coalesce(gtin, '')
      )
    ) STORED
  `);
  await knex.raw(
    "CREATE INDEX variants_search_document_idx ON variants USING gin (search_document)",
  );
  await knex.raw(
    "CREATE INDEX variants_name_trgm_idx ON variants USING gin (name gin_trgm_ops)",
  );
  await knex.raw(
    "CREATE INDEX variants_gtin_trgm_idx ON variants USING gin (gtin gin_trgm_ops)",
  );
  await knex.raw(
    "CREATE INDEX variants_mpn_trgm_idx ON variants USING gin (manufacturer_part_number gin_trgm_ops)",
  );
  await knex.raw(
    "CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops)",
  );

  // A tsvector over products.attributes would need an immutable function; a
  // table trigger is enough because attribute writes go through ingestion and
  // attribute review, both of which update variants. The document holds the
  // variant's own words plus its product's, so "monitor" reaches a variant
  // named "27-inch 4K USB-C" under a product called "Dell UltraSharp".
  await knex.schema.createTable("variant_search_documents", (t) => {
    t.uuid("variant_id").primary().references("id").inTable("variants").onDelete("CASCADE");
    t.specificType("search_document", "tsvector").notNullable();
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "CREATE INDEX variant_search_documents_document_idx " +
      "ON variant_search_documents USING gin (search_document)",
  );
  // Attribute names are part of the document so "zwart" or "colour" finds a
  // variant whose attributes carry them; values follow.
  await knex.raw(`
    CREATE FUNCTION variant_search_document_attributes(attributes jsonb)
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT coalesce(string_agg(key || ' ' || value, ' '), '')
      FROM jsonb_each_text(coalesce(attributes, '{}'::jsonb))
    $$
  `);
  await knex.raw(`
    CREATE FUNCTION variant_search_document(
      variant_name text, gtin text, mpn text, attributes jsonb, product_text text
    ) RETURNS tsvector LANGUAGE sql IMMUTABLE AS $$
      SELECT to_tsvector(
        'simple',
        coalesce(variant_name, '') || ' ' ||
        coalesce(gtin, '') || ' ' ||
        coalesce(mpn, '') || ' ' ||
        variant_search_document_attributes(attributes) || ' ' ||
        coalesce(product_text, '')
      )
    $$
  `);
  await knex.raw(`
    CREATE FUNCTION refresh_variant_search_document() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      product_text text;
    BEGIN
      SELECT coalesce(name, '') || ' ' || coalesce(manufacturer, '') || ' ' ||
             coalesce(category, '')
        INTO product_text
        FROM products WHERE id = NEW.product_id;
      INSERT INTO variant_search_documents (variant_id, search_document, updated_at)
      VALUES (
        NEW.id,
        variant_search_document(NEW.name, NEW.gtin, NEW.manufacturer_part_number, NEW.attributes, product_text),
        now()
      )
      ON CONFLICT (variant_id) DO UPDATE
        SET search_document = EXCLUDED.search_document, updated_at = now();
      RETURN NEW;
    END
    $$
  `);
  await knex.raw(`
    CREATE TRIGGER variants_search_document_refresh
    AFTER INSERT OR UPDATE OF name, gtin, manufacturer_part_number, attributes, product_id ON variants
    FOR EACH ROW EXECUTE FUNCTION refresh_variant_search_document()
  `);
  await knex.raw(`
    INSERT INTO variant_search_documents (variant_id, search_document)
    SELECT variants.id, variant_search_document(
      variants.name, variants.gtin, variants.manufacturer_part_number, variants.attributes,
      coalesce(products.name, '') || ' ' || coalesce(products.manufacturer, '') || ' ' || coalesce(products.category, '')
    )
    FROM variants JOIN products ON products.id = variants.product_id
    ON CONFLICT (variant_id) DO NOTHING
  `);

  // Canonical attributes become filterable, each with the storage type the
  // filter runs against. New attributes default to text and can be tuned.
  await knex.schema.alterTable("catalogue_attributes", (t) => {
    t.boolean("is_filterable").notNullable().defaultTo(false);
    t.text("filter_kind").notNullable().defaultTo("text");
  });
  await knex.raw(
    "ALTER TABLE catalogue_attributes ADD CONSTRAINT catalogue_attributes_filter_kind_check " +
      "CHECK (filter_kind IN ('text', 'number', 'boolean'))",
  );

  // Search vocabulary: one row per meaning (a brand, a category, a product
  // term, a colour), each carrying its English and Dutch surface forms. The
  // term table is what the search reads, so a single lookup covers both
  // languages and every language a self-hosted installation adds later.
  await knex.schema.createTable("catalogue_search_vocabulary", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("concept").notNullable().unique();
    t.text("attribute_key");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.createTable("catalogue_search_vocabulary_terms", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("vocabulary_id").notNullable()
      .references("id").inTable("catalogue_search_vocabulary").onDelete("CASCADE");
    t.text("language").notNullable();
    t.text("term").notNullable();
    t.unique(["term", "language"]);
  });
  await knex.raw(
    "CREATE INDEX catalogue_search_vocabulary_terms_term_trgm_idx " +
      "ON catalogue_search_vocabulary_terms USING gin (term gin_trgm_ops)",
  );
  await knex.raw(
    "CREATE INDEX catalogue_search_vocabulary_terms_language_idx " +
      "ON catalogue_search_vocabulary_terms (language)",
  );

  const vocabulary: Array<{
    concept: string;
    attributeKey: string | null;
    terms: Array<[string, string]>;
  }> = [
    {
      concept: "monitor",
      attributeKey: null,
      terms: [
        ["monitor", "en"], ["monitors", "en"], ["screen", "en"],
        ["monitor", "nl"], ["monitoren", "nl"], ["beeldscherm", "nl"], ["beeldschermen", "nl"],
      ],
    },
    {
      concept: "kettle",
      attributeKey: null,
      terms: [
        ["kettle", "en"], ["kettles", "en"], ["electric kettle", "en"],
        ["ketel", "nl"], ["waterkoker", "nl"], ["waterkokers", "nl"],
      ],
    },
    {
      concept: "refrigerator",
      attributeKey: null,
      terms: [
        ["fridge", "en"], ["refrigerator", "en"],
        ["koelkast", "nl"], ["koelkasten", "nl"], ["ijskast", "nl"],
      ],
    },
    {
      concept: "headphones",
      attributeKey: null,
      terms: [
        ["headphones", "en"], ["headphone", "en"], ["earphones", "en"],
        ["hoofdtelefoon", "nl"], ["koptelefoon", "nl"], ["oortelefoon", "nl"],
      ],
    },
    {
      concept: "wireless",
      attributeKey: null,
      terms: [
        ["wireless", "en"], ["wireless", "nl"], ["draadloos", "nl"], ["draadloze", "nl"],
      ],
    },
    {
      concept: "dutch term for new",
      attributeKey: null,
      terms: [["new", "en"], ["nieuw", "nl"], ["nieuwe", "nl"]],
    },
    {
      concept: "colour",
      attributeKey: "colour",
      terms: [
        ["black", "en"], ["black", "nl"], ["zwart", "nl"], ["zwarte", "nl"],
        ["white", "en"], ["white", "nl"], ["wit", "nl"], ["witte", "nl"],
        ["grey", "en"], ["gray", "en"], ["grijs", "nl"], ["grijze", "nl"],
        ["blue", "en"], ["blue", "nl"], ["blauw", "nl"], ["blauwe", "nl"],
        ["red", "en"], ["red", "nl"], ["rood", "nl"], ["rode", "nl"],
        ["silver", "en"], ["silver", "nl"], ["zilver", "nl"],
      ],
    },
    {
      concept: "condition",
      attributeKey: "condition",
      terms: [
        ["refurbished", "en"], ["refurbished", "nl"], ["refurbish", "en"],
        ["opgeknapt", "nl"], ["tweedehands", "nl"], ["used", "en"], ["tweedehands", "en"],
      ],
    },
    {
      concept: "power_w",
      attributeKey: "power_w",
      terms: [["watt", "en"], ["watt", "nl"], ["watts", "en"], ["w", "en"], ["w", "nl"]],
    },
    {
      concept: "screen_size_inch",
      attributeKey: "screen_size_inch",
      terms: [
        ["inch", "en"], ["inches", "en"], ["inch", "nl"], ["inches", "nl"],
        ["duim", "nl"], ["schermgrootte", "nl"], ["screen size", "en"],
      ],
    },
  ];
  for (const entry of vocabulary) {
    const [row] = await knex("catalogue_search_vocabulary")
      .insert({ concept: entry.concept, attribute_key: entry.attributeKey })
      .returning("id");
    await knex("catalogue_search_vocabulary_terms").insert(
      entry.terms.map(([term, language]) => ({
        vocabulary_id: row.id,
        term,
        language,
      })),
    );
  }

  await knex("catalogue_attributes")
    .whereIn("key", ["colour", "power_w", "screen_size_inch"])
    .update({ is_filterable: true, filter_kind: knex.raw("value_type") });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("DROP TRIGGER IF EXISTS variants_search_document_refresh ON variants");
  await knex.raw("DROP FUNCTION IF EXISTS refresh_variant_search_document()");
  await knex.raw("DROP FUNCTION IF EXISTS variant_search_document(text, text, text, jsonb, text)");
  await knex.raw("DROP FUNCTION IF EXISTS variant_search_document_attributes(jsonb)");
  await knex.schema.dropTableIfExists("variant_search_documents");
  await knex.schema.dropTableIfExists("catalogue_search_vocabulary_terms");
  await knex.schema.dropTableIfExists("catalogue_search_vocabulary");
  await knex.schema.alterTable("catalogue_attributes", (t) => {
    t.dropColumns("is_filterable", "filter_kind");
  });
  await knex.raw("DROP INDEX IF EXISTS products_name_trgm_idx");
  await knex.raw("DROP INDEX IF EXISTS variants_mpn_trgm_idx");
  await knex.raw("DROP INDEX IF EXISTS variants_gtin_trgm_idx");
  await knex.raw("DROP INDEX IF EXISTS variants_name_trgm_idx");
  await knex.raw("DROP INDEX IF EXISTS variants_search_document_idx");
  await knex.raw("ALTER TABLE variants DROP COLUMN IF EXISTS search_document");
}
