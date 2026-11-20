// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "./errors";
import { addMoney, compareMoney } from "./money";
import { isAuthorized, type Principal } from "./principal";
import {
  analyseQuery,
  MAX_IDENTIFIER_LENGTH,
  MAX_SEARCH_TEXT_LENGTH,
  type AnalysedQuery,
  type QueryExpansion,
  type VocabularyTerm,
} from "./catalogue-search-query";

/**
 * Catalogue search: exact model identifiers first, then structured attribute
 * filters, then English/Dutch wording.
 *
 * Every shopper-supplied value travels as a Knex binding. The only SQL shapes
 * chosen at runtime are the JSONB attribute key and cast selected from the
 * canonical attribute vocabulary, so a query string never reaches the planner
 * as syntax.
 */

export type FilterOperator = "eq" | "gte" | "lte";

export interface AttributeFilter {
  key: string;
  value: string;
  /** Defaults to `eq`. Numeric attributes compare numerically, text exactly. */
  op?: FilterOperator;
}

export interface CatalogueSearchQuery {
  /** GTIN or manufacturer part number, matched exactly (case-insensitively). */
  identifiers?: string;
  /** Free wording in English or Dutch. */
  text?: string;
  filters?: AttributeFilter[];
  limit?: number;
}

export interface SearchMatch {
  mode: "identifier" | "attribute" | "text" | "typo";
  /** Which identifier column matched, when mode is `identifier`. */
  kind?: "gtin" | "model";
  /** The shopper's value that produced this match, preserved verbatim. */
  value: string;
}

export interface ResultPrice {
  amount: string;
  currency: string;
  shippingAmount: string;
  deliveredAmount: string;
  vatIncluded: boolean;
  observedAt: string;
}

export interface ResultOfferSummary {
  /** Cheapest delivered total among offers with a fresh observation. */
  best: ResultPrice | null;
  /** Known offers whose price has never been observed. */
  unknownPriceCount: number;
}

export type AttributeStatus = "verified" | "unverified";

export interface AttributeProvenance {
  /** `verified` only when an accepted source claim backs the value. */
  status: AttributeStatus;
  sourceUrl: string | null;
  observedAt: string | null;
}

export interface CatalogueSearchResult {
  variant: {
    id: string;
    name: string;
    /** Canonical attributes only; unresolved claims never appear here. */
    attributes: Record<string, unknown>;
    product: {
      id: string;
      name: string;
      manufacturer: string | null;
      category: string | null;
      isDevelopmentFixture: boolean;
    };
  };
  /** Stored identifier spellings, untouched by case-insensitive matching. */
  identifiers: { gtin: string | null; manufacturerPartNumber: string | null };
  offers: ResultOfferSummary;
  sources: Array<{ sourceUrl: string; observedAt: string }>;
  /** `verified` when nothing about this result is inferred; `partial` otherwise. */
  uncertainty: "verified" | "partial";
  /** Query terms this result does not explain, e.g. a stray modifier. */
  unmatchedTerms: string[];
  attributeProvenance: Record<string, AttributeProvenance>;
  match: SearchMatch;
  score: number;
}

export interface CatalogueSearchResponse {
  query: {
    identifiers: string | null;
    text: string | null;
    filters: AttributeFilter[];
  };
  /** Vocabulary concepts the wording reached, with both languages' forms. */
  expansion: QueryExpansion[];
  results: CatalogueSearchResult[];
}

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

interface FilterableAttribute {
  key: string;
  filterKind: "text" | "number" | "boolean";
}

interface FilterableAttributeRow {
  key: string;
  filter_kind: "text" | "number" | "boolean";
}

interface Candidate {
  variantId: string;
  mode: SearchMatch["mode"];
  kind?: "gtin" | "model";
  value: string;
  score: number;
  /** Lexemes of the shopper's wording that reached this row. */
  matchedLexemes: string[];
}

interface IdentifierRow {
  id: string;
  gtin: string | null;
  manufacturer_part_number: string | null;
}

interface VariantRow {
  id: string;
  name: string;
  gtin: string | null;
  manufacturer_part_number: string | null;
  attributes: Record<string, unknown>;
  product_id: string;
  product_name: string;
  product_manufacturer: string | null;
  product_category: string | null;
  product_is_development_fixture: boolean;
}

interface SourceRow {
  variant_id: string;
  source_url: string;
  observed_at: Date;
}

interface ClaimRow {
  variant_id: string;
  field: string;
  raw_name: string | null;
  mapping_status: string | null;
  observed_at: Date;
  source_url: string;
}

interface OfferRow {
  variant_id: string;
  amount: string | null;
  currency: string | null;
  shipping_amount: string | null;
  vat_included: boolean | null;
  observed_at: Date | null;
}

export async function searchCatalogue(
  db: Knex,
  principal: Principal,
  query: CatalogueSearchQuery,
): Promise<Result<CatalogueSearchResponse>> {
  if (!isAuthorized(principal, "catalogue.read")) {
    return err({ kind: "forbidden", capability: "catalogue.read" });
  }

  const identifiers = query.identifiers?.trim() ?? "";
  const text = query.text?.trim() ?? "";
  const filters = query.filters ?? [];
  const limit = clampLimit(query.limit);

  if (identifiers.length > MAX_IDENTIFIER_LENGTH) {
    return err({
      kind: "invalid-input",
      field: "identifiers",
      message: `identifiers must be ${MAX_IDENTIFIER_LENGTH} characters or fewer`,
    });
  }
  if (text.length > MAX_SEARCH_TEXT_LENGTH) {
    return err({
      kind: "invalid-input",
      field: "text",
      message: `text must be ${MAX_SEARCH_TEXT_LENGTH} characters or fewer`,
    });
  }
  if (!identifiers && !text && filters.length === 0) {
    return err({
      kind: "invalid-input",
      field: "query",
      message: "Provide a model identifier, search text, or a filter",
    });
  }

  const attributeRows = (await db("catalogue_attributes")
    .where({ is_filterable: true })
    .select("key", "filter_kind")) as FilterableAttributeRow[];
  const filterable = new Map(
    attributeRows.map((row) => [row.key, { key: row.key, filterKind: row.filter_kind }]),
  );

  for (const filter of filters) {
    const attribute = filterable.get(filter.key);
    if (!attribute) {
      return err({
        kind: "invalid-input",
        field: `filters.${filter.key}`,
        message: `${filter.key} is not a filterable catalogue attribute`,
      });
    }
    if (attribute.filterKind === "number" && !Number.isFinite(Number(filter.value))) {
      return err({
        kind: "invalid-input",
        field: `filters.${filter.key}`,
        message: `${filter.key} takes a number`,
      });
    }
    const op = filter.op ?? "eq";
    if (op !== "eq" && op !== "gte" && op !== "lte") {
      return err({
        kind: "invalid-input",
        field: `filters.${filter.key}.op`,
        message: `${op} is not a supported filter operator`,
      });
    }
  }

  const vocabulary = (await db("catalogue_search_vocabulary_terms as terms")
    .join(
      "catalogue_search_vocabulary as vocabulary",
      "vocabulary.id",
      "terms.vocabulary_id",
    )
    .select("terms.term", "terms.language", "vocabulary.concept")) as VocabularyTerm[];
  const analysed = analyseQuery(text, vocabulary);

  // Candidate stage: each retrieval path records the best score it can offer
  // per variant, so a result reached by identifier is never outranked by one
  // reached by wording.
  const candidates = new Map<string, Candidate>();
  const record = (candidate: Candidate) => {
    const existing = candidates.get(candidate.variantId);
    if (!existing || existing.score < candidate.score) {
      candidates.set(candidate.variantId, candidate);
    }
  };

  const wordingHits = new Set<string>();
  const filterHits = new Set<string>();

  if (identifiers) {
    for (const row of await matchIdentifiers(db, identifiers)) {
      const modelMatch =
        row.manufacturer_part_number !== null &&
        normalizeIdentifier(row.manufacturer_part_number) ===
          normalizeIdentifier(identifiers);
      record({
        variantId: row.id,
        mode: "identifier",
        kind: modelMatch ? "model" : "gtin",
        value: identifiers,
        score: 1000,
        matchedLexemes: [],
      });
    }
  }

  // Canonical attribute values only: a claim that was never accepted is absent
  // from variants.attributes, so it cannot satisfy a filter.
  if (filters.length > 0) {
    for (const row of await matchFilters(db, filters, filterable)) {
      filterHits.add(row.id);
      record({
        variantId: row.id,
        mode: "attribute",
        value: filters.map((filter) => filter.value).join(", "),
        score: 500,
        matchedLexemes: [],
      });
    }
  }

  if (text && analysed.terms.length > 0) {
    for (const row of await matchText(db, analysed)) {
      wordingHits.add(row.variantId);
      record(row);
    }
  }

  // Text and filter paths are combined by intersection: when a query carries
  // wording and filters together, every result must satisfy both. Identifier
  // matches bypass filters (an exact model number is an exact answer), and a
  // text-only or filter-only query intersects with nothing.
  const combined = wordingHits.size > 0 && filterHits.size > 0;
  const keep = (candidate: Candidate) =>
    candidate.mode === "identifier" ||
    !combined ||
    (wordingHits.has(candidate.variantId) && filterHits.has(candidate.variantId));

  const ordered = [...candidates.values()]
    .filter(keep)
    .sort((left, right) => right.score - left.score || left.variantId.localeCompare(right.variantId))
    .slice(0, limit);
  const results = await loadResults(db, ordered, analysed, vocabulary);

  return ok({
    query: {
      identifiers: identifiers || null,
      text: text || null,
      filters,
    },
    expansion: analysed.expansions,
    results,
  });
}

async function matchIdentifiers(
  db: Knex,
  identifiers: string,
): Promise<IdentifierRow[]> {
  const exact = await db("variants")
    .select("id", "gtin", "manufacturer_part_number")
    .whereRaw("lower(manufacturer_part_number) = lower(?)", [identifiers])
    .orWhereRaw("lower(gtin) = lower(?)", [identifiers]);
  if (exact.length > 0) return exact;
  // "VP27 BLK" and "vp27.blk" should reach "VP27-BLK": retry with separators
  // stripped only when the literal spelling found nothing.
  if (!/[\s._/-]/.test(identifiers)) return exact;
  const stripped = identifiers.replace(/[\s._/-]+/g, "");
  return db("variants")
    .select("id", "gtin", "manufacturer_part_number")
    .whereRaw(
      "lower(regexp_replace(manufacturer_part_number, '[\\s._/-]+', '', 'g')) = lower(?)",
      [stripped],
    )
    .orWhereRaw(
      "lower(regexp_replace(gtin, '[\\s._/-]+', '', 'g')) = lower(?)",
      [stripped],
    );
}

async function matchFilters(
  db: Knex,
  filters: readonly AttributeFilter[],
  filterable: ReadonlyMap<string, FilterableAttribute>,
): Promise<Array<{ id: string }>> {
  const query = db("variants").select("variants.id");

  for (const filter of filters) {
    const attribute = filterable.get(filter.key)!;
    const op = filter.op ?? "eq";
    const kind = attribute.filterKind;
    query.andWhere((builder) => {
      if (kind === "number") {
        const comparison = op === "eq" ? "=" : op === "gte" ? ">=" : "<=";
        builder.whereRaw(
          `(variants.attributes ->> ?)::numeric ${comparison} ?::numeric`,
          [filter.key, filter.value],
        );
      } else if (kind === "boolean") {
        builder.whereRaw("(variants.attributes ->> ?)::boolean = ?::boolean", [
          filter.key,
          filter.value,
        ]);
      } else {
        builder.whereRaw("lower(variants.attributes ->> ?) = lower(?)", [
          filter.key,
          filter.value,
        ]);
      }
    });
  }
  return query;
}

/**
 * Full-text match against the stored `simple` tsvector, expanded by the
 * vocabulary, then word-similarity (pg_trgm) for misspellings. The document is
 * read back as text so a card can say which of the shopper's words it explains;
 * the matching itself stays inside PostgreSQL, on its GIN indexes.
 *
 * All of the shopper's words must appear (an expanded concept stands in for the
 * word that reached it). Only when that finds nothing does the search widen to
 * any word, and those results are ranked below and labelled `typo` so a loose
 * match is never presented as an exact one.
 */
async function matchText(
  db: Knex,
  analysed: AnalysedQuery,
): Promise<Candidate[]> {
  const lexemes = [...new Set(analysed.terms.flatMap((term) => term.lexemes))];
  const expansionsByLexeme = new Map<string, QueryExpansion>();
  const expansionsByWord = new Map<string, QueryExpansion>();
  for (const expansion of analysed.expansions) {
    for (const term of analysed.terms) {
      if (term.concepts.includes(expansion.concept)) {
        expansionsByWord.set(term.raw, expansion);
        for (const lexeme of term.lexemes) expansionsByLexeme.set(lexeme, expansion);
      }
    }
  }
  const expansionLexemes = [
    ...new Set(analysed.expansions.flatMap((expansion) => expansion.lexemes)),
  ];
  const asShopperTyped = lexemes.join(" ");
  const withVocabulary = [...new Set([...lexemes, ...expansionLexemes])].join(" ");

  /**
   * A document matches when every word the shopper typed is present, either
   * literally or through the vocabulary concept that word reached. Words the
   * vocabulary did not reach (numbers, brand names, stray modifiers) must be
   * present literally: the search never pretends to have understood them.
   */
  const score = (document: Set<string>): Candidate["matchedLexemes"] | null => {
    const reached: string[] = [];
    for (const term of analysed.terms) {
      const literal = term.lexemes.filter((lexeme) => document.has(lexeme));
      if (literal.length > 0) {
        reached.push(...literal);
        continue;
      }
      const expansion = expansionsByWord.get(term.raw);
      const viaConcept = expansion
        ? expansion.lexemes.filter((lexeme) => document.has(lexeme))
        : [];
      if (viaConcept.length === 0) return null;
      reached.push(...viaConcept);
    }
    return reached;
  };

  const matched = new Map<string, Candidate>();
  const allWords = asShopperTyped
    ? await searchDocuments(db, asShopperTyped, "and", expansionsByWord)
    : [];
  for (const row of allWords) {
    const reached = score(lexemesOfDocument(row.document));
    if (reached === null) continue;
    matched.set(row.variant_id, {
      variantId: row.variant_id,
      mode: "text",
      value: asShopperTyped,
      score: 300 + reached.length * 10,
      matchedLexemes: reached,
    });
  }
  if (matched.size > 0) return [...matched.values()];

  // Nothing matched every word as typed, so widen: the expansion (other
  // surface forms of the concepts reached) is OR-ed in, and a multi-word query
  // may match on any word. These are ranked below exact matches and labelled
  // `typo`, so a loose match is never presented as an exact one.
  const widened = withVocabulary !== asShopperTyped
    ? await searchDocuments(db, withVocabulary, "or", expansionsByWord)
    : allWords;
  // The OR pass may match on any word; the words it could not find stay
  // unexplained and make the result `partial`.
  for (const row of widened) {
    const document = lexemesOfDocument(row.document);
    const reached = [...new Set([...document].filter((lexeme) =>
      expansionsByLexeme.has(lexeme) ||
      analysed.terms.some((term) =>
        term.lexemes.includes(lexeme) ||
        (expansionsByWord.get(term.raw)?.lexemes.includes(lexeme) ?? false),
      ),
    ))];
    if (reached.length === 0) continue;
    matched.set(row.variant_id, {
      variantId: row.variant_id,
      mode: "typo",
      value: asShopperTyped,
      score: 120 + reached.length * 10,
      matchedLexemes: reached,
    });
  }
  if (matched.size > 0) return [...matched.values()];

  // Misspellings: compare the shopper's words with the words the tsvector
  // holds using pg_trgm's word_similarity, which is index-supported.
  if (asShopperTyped) {
    const rows = (await db("variant_search_documents as documents")
      .select(
        "documents.variant_id",
        db.raw("documents.search_document::text as document"),
      )
      .whereRaw("? <% documents.search_document::text", [asShopperTyped])
      .orderByRaw("word_similarity(?, documents.search_document::text) desc", [asShopperTyped])
      .limit(50)) as Array<{ variant_id: string; document: string }>;
    for (const row of rows) {
      matched.set(row.variant_id, {
        variantId: row.variant_id,
        mode: "typo",
        value: asShopperTyped,
        score: 150,
        matchedLexemes: [],
      });
    }
  }

  return [...matched.values()];
}

/**
 * Rows whose document holds the query's words. Every word the shopper typed is
 * required (as typed); a word the vocabulary understood is additionally
 * accepted through the concept's other surface forms, so "monitoren" reaches a
 * catalogue that only ever writes "monitor" without a word being dropped.
 */
async function searchDocuments(
  db: Knex,
  query: string,
  mode: "and" | "or",
  expansionsByWord: ReadonlyMap<string, QueryExpansion>,
): Promise<Array<{ variant_id: string; document: string }>> {
  const terms = query.split(/\s+/).filter(Boolean);
  const group = (word: string) => {
    const alternatives = [word];
    const expansion = expansionsByWord.get(word);
    if (expansion) {
      alternatives.push(...expansion.lexemes.filter((lexeme) => lexeme !== word));
    }
    return alternatives.length > 1 ? `(${alternatives.join(" | ")})` : word;
  };
  const expression = mode === "and"
    ? terms.map(group).join(" & ")
    : terms.map(group).join(" | ");
  return db("variant_search_documents as documents")
    .select("documents.variant_id", db.raw("documents.search_document::text as document"))
    .whereRaw("documents.search_document @@ to_tsquery('simple', ?)", [expression]);
}

/** Lexemes of a tsvector rendered as text, e.g. `'27':9 'black':2`. */
function lexemesOfDocument(document: string): Set<string> {
  const words = document.match(/'([^']*)'/g) ?? [];
  return new Set(words.map((word) => word.slice(1, -1)));
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[\s._/-]+/g, "").toLowerCase();
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

async function loadResults(
  db: Knex,
  candidates: readonly Candidate[],
  analysed: ReturnType<typeof analyseQuery>,
  vocabulary: readonly VocabularyTerm[],
): Promise<CatalogueSearchResult[]> {
  if (candidates.length === 0) return [];
  const ids = candidates.map((candidate) => candidate.variantId);

  const variantRows = (await db("variants")
    .join("products", "products.id", "variants.product_id")
    .select(
      "variants.id",
      "variants.name",
      "variants.gtin",
      "variants.manufacturer_part_number",
      "variants.attributes",
      "products.id as product_id",
      "products.name as product_name",
      "products.manufacturer as product_manufacturer",
      "products.category as product_category",
      "products.is_development_fixture as product_is_development_fixture",
    )
    .whereIn("variants.id", ids)) as VariantRow[];
  const variants = new Map(variantRows.map((row) => [row.id, row]));

  const sources = (await db("source_evidence as evidence")
    .join("source_claims as claims", "claims.evidence_id", "evidence.id")
    .whereIn("claims.variant_id", ids)
    .select(
      "claims.variant_id",
      "evidence.source_url",
      "evidence.observed_at",
    )
    .orderBy("evidence.observed_at", "desc")) as SourceRow[];
  const sourcesByVariant = new Map<string, SourceRow[]>();
  for (const source of sources) {
    const list = sourcesByVariant.get(source.variant_id) ?? [];
    list.push(source);
    sourcesByVariant.set(source.variant_id, list);
  }

  const claims = (await db("source_claims as claims")
    .join("source_evidence as evidence", "evidence.id", "claims.evidence_id")
    .whereIn("claims.variant_id", ids)
    .whereIn("claims.mapping_status", ["accepted", "unresolved"])
    .select(
      "claims.variant_id",
      "claims.field",
      "claims.raw_name",
      "claims.mapping_status",
      "claims.observed_at",
      "evidence.source_url",
    )
    .orderBy("claims.observed_at", "desc")) as ClaimRow[];

  const offers = (await db("offers")
    .leftJoin(
      db("price_observations")
        .distinctOn("offer_id")
        .select(
          "offer_id",
          "amount",
          "currency",
          "shipping_amount",
          "vat_included",
          "observed_at",
        )
        .orderBy([
          { column: "offer_id" },
          { column: "observed_at", order: "desc" },
        ])
        .as("latest_observation"),
      "latest_observation.offer_id",
      "offers.id",
    )
    .whereIn("offers.variant_id", ids)
    .select(
      "offers.variant_id",
      "latest_observation.amount as amount",
      "latest_observation.currency as currency",
      "latest_observation.shipping_amount as shipping_amount",
      "latest_observation.vat_included as vat_included",
      "latest_observation.observed_at as observed_at",
    )) as OfferRow[];

  // A term the vocabulary reached only through typo tolerance explains itself
  // ("monitr" means "monitor"); a genuinely unknown word stays unexplained.
  const approximate = new Set(
    analysed.expansions.filter((expansion) => expansion.approximate).map((expansion) => expansion.matched),
  );
  // Only words the vocabulary could not reach at all are candidates for being
  // unexplained; a word understood by typo tolerance explains itself.
  const freeTextTerms = analysed.terms.filter((term) => !term.known);
  const documents = new Map<string, Set<string>>();
  if (freeTextTerms.length > 0) {
    const rows = await db("variant_search_documents as documents")
      .whereIn("documents.variant_id", ids)
      .select("documents.variant_id", db.raw("documents.search_document::text as document"));
    for (const row of rows) documents.set(row.variant_id, lexemesOfDocument(row.document));
  }

  return candidates.flatMap((candidate) => {
    const variant = variants.get(candidate.variantId);
    if (!variant) return [];
    const variantSources = dedupeSources(sourcesByVariant.get(candidate.variantId) ?? []);
    const variantClaims = claims.filter((claim) => claim.variant_id === candidate.variantId);
    const attributes = variant.attributes ?? {};
    const attributeProvenance = Object.fromEntries(
      Object.keys(attributes).map((key) => [key, provenanceFor(key, variantClaims, vocabulary)]),
    );

    // A word is explained when the result holds it literally or holds another
    // surface form of the concept it reached; a word understood only by typo
    // tolerance explains itself. Everything else is listed, and any of it makes
    // the result `partial` rather than a confident match.
    const documentWords = documents.get(candidate.variantId) ?? new Set<string>();
    const unexplained = new Set<string>();
    for (const term of freeTextTerms) {
      // A word the vocabulary does not know is still explained when this
      // result literally holds it (a number, a brand, "RVS").
      const held = term.lexemes.some(
        (lexeme) => documentWords.has(lexeme) || candidate.matchedLexemes.includes(lexeme),
      );
      if (!held) unexplained.add(term.raw);
    }
    if (analysed.terms.length > 0 && candidate.matchedLexemes.length > 0) {
      for (const term of analysed.terms) {
        if (approximate.has(term.raw)) continue;
        const literal = term.lexemes.some((lexeme) => candidate.matchedLexemes.includes(lexeme));
        const expansion = analysed.expansions.find((entry) => term.concepts.includes(entry.concept));
        const viaConcept = expansion
          ? expansion.lexemes.some((lexeme) => candidate.matchedLexemes.includes(lexeme))
          : false;
        if (!literal && !viaConcept) unexplained.add(term.raw);
      }
    }

    return [{
      variant: {
        id: variant.id,
        name: variant.name,
        attributes,
        product: {
          id: variant.product_id,
          name: variant.product_name,
          manufacturer: variant.product_manufacturer,
          category: variant.product_category,
          isDevelopmentFixture: variant.product_is_development_fixture,
        },
      },
      identifiers: {
        gtin: variant.gtin,
        manufacturerPartNumber: variant.manufacturer_part_number,
      },
      offers: summarizeOffers(offers.filter((offer) => offer.variant_id === variant.id)),
      sources: variantSources,
      uncertainty: unexplained.size > 0 ? "partial" : "verified",
      unmatchedTerms: [...unexplained],
      attributeProvenance,
      match: {
        mode: candidate.mode,
        ...(candidate.kind ? { kind: candidate.kind } : {}),
        value: candidate.value,
      },
      score: candidate.score,
    }];
  });
}

function dedupeSources(sources: readonly SourceRow[]): Array<{ sourceUrl: string; observedAt: string }> {
  const seen = new Set<string>();
  const result: Array<{ sourceUrl: string; observedAt: string }> = [];
  for (const source of sources) {
    const observedAt = new Date(source.observed_at).toISOString();
    const key = `${source.source_url}|${observedAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ sourceUrl: source.source_url, observedAt });
  }
  return result;
}

/**
 * Provenance for one canonical attribute: verified only when an accepted claim
 * for that key exists. Values that arrived with the variant row itself have no
 * accepted claim and stay unverified rather than being presented as facts.
 */
function provenanceFor(
  key: string,
  claims: readonly ClaimRow[],
  vocabulary: readonly VocabularyTerm[],
): AttributeProvenance {
  const aliases = new Set(
    vocabulary
      .filter((entry) => entry.concept === key)
      .flatMap((entry) => [entry.term.toLowerCase(), ...entry.term.toLowerCase().split(/\s+/)]),
  );
  const accepted = claims.find((claim) => {
    if (claim.mapping_status !== "accepted") return false;
    if (claim.field === `attribute.${key}`) return true;
    const raw = claim.raw_name?.toLowerCase() ?? claim.field.replace("attribute.", "").toLowerCase();
    return aliases.has(raw) || aliases.has(raw.replace(/[\s-]+/g, "_"));
  });
  return accepted
    ? {
        status: "verified",
        sourceUrl: accepted.source_url,
        observedAt: new Date(accepted.observed_at).toISOString(),
      }
    : { status: "unverified", sourceUrl: null, observedAt: null };
}

function summarizeOffers(offers: readonly OfferRow[]): ResultOfferSummary {
  let best: ResultPrice | null = null;
  let unknownPriceCount = 0;
  for (const offer of offers) {
    if (offer.amount == null || offer.currency == null || offer.observed_at == null) {
      unknownPriceCount += 1;
      continue;
    }
    const price: ResultPrice = {
      amount: String(offer.amount),
      currency: offer.currency.trim(),
      shippingAmount: String(offer.shipping_amount ?? "0.00"),
      deliveredAmount: addMoney(String(offer.amount), String(offer.shipping_amount ?? "0.00")),
      vatIncluded: offer.vat_included ?? true,
      observedAt: new Date(offer.observed_at).toISOString(),
    };
    if (best === null || compareMoney(price.deliveredAmount, best.deliveredAmount) < 0) {
      best = price;
    }
  }
  return { best, unknownPriceCount };
}
