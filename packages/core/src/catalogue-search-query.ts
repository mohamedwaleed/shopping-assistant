// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Query analysis for catalogue search.
 *
 * Wording is normalised with PostgreSQL's own `simple` dictionary rules so the
 * terms we expand match the terms the stored tsvectors hold (case folding,
 * punctuation, a trailing possessive). Language is not inferred: the catalogue
 * and the shopper may each use English or Dutch, so a term is looked up against
 * the installation's vocabulary in both languages at once.
 */

/** Query terms are short by nature; the bound also caps provider work. */
export const MAX_SEARCH_TEXT_LENGTH = 200;
export const MAX_SEARCH_TERMS = 12;
export const MAX_IDENTIFIER_LENGTH = 64;

export interface VocabularyTerm {
  term: string;
  language: string;
  concept: string;
}

export interface SearchTerm {
  /** The term as the shopper typed it (trimmed). */
  raw: string;
  /** Lexemes PostgreSQL will index and match for this term. */
  lexemes: string[];
  /** Vocabulary concepts this term belongs to, across every language. */
  concepts: string[];
  /** True when the term is recognised vocabulary, so it is not free text. */
  known: boolean;
}

export interface QueryExpansion {
  concept: string;
  /** The shopper's term that reached the concept. */
  matched: string;
  /** Every surface form of the concept, both languages. */
  terms: string[];
  /** Lexemes of those forms, used for the `||` expansion. */
  lexemes: string[];
  /** True when the term only reached the concept through typo tolerance. */
  approximate: boolean;
}

export interface AnalysedQuery {
  terms: SearchTerm[];
  expansions: QueryExpansion[];
  /** True when at least one term is unknown to the vocabulary. */
  hasFreeText: boolean;
}

/**
 * Lexemes PostgreSQL's `simple` configuration produces for one word. Matching
 * the server's tokeniser here keeps expansion honest: a term we cannot
 * normalise is simply not expanded rather than guessed at.
 */
export function simpleLexemes(word: string): string[] {
  return word
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Splits a free-text query into terms, resolving each against the vocabulary.
 * A term is matched by lexeme equality first and by typo similarity second, so
 * "monitr" still reaches the "monitor" concept without any fuzzy indexing on
 * the shopper's own words.
 */
export function analyseQuery(
  text: string,
  vocabulary: readonly VocabularyTerm[],
): AnalysedQuery {
  const byLexeme = new Map<string, VocabularyTerm[]>();
  for (const entry of vocabulary) {
    for (const lexeme of simpleLexemes(entry.term)) {
      const existing = byLexeme.get(lexeme) ?? [];
      existing.push(entry);
      byLexeme.set(lexeme, existing);
    }
  }

  const terms: SearchTerm[] = [];
  const approximate = new Set<string>();
  for (const token of tokenize(text).slice(0, MAX_SEARCH_TERMS)) {
    const lexemes = simpleLexemes(token);
    if (lexemes.length === 0) continue;
    const matches = lexemes.flatMap((lexeme) => byLexeme.get(lexeme) ?? []);
    terms.push({
      raw: token,
      lexemes,
      concepts: [...new Set(matches.map((match) => match.concept))],
      known: matches.length > 0,
    });
  }

  // Typo recovery: a misspelled product term still reaches its concept, so
  // "monitr" searches what "monitor" would. Terms reached only this way are
  // marked approximate and contribute nothing else — they are never reported
  // as unexplained, and never widened into a colour or condition guess.
  for (const term of terms) {
    if (term.known) continue;
    const near = nearestConcept(term.raw, vocabulary);
    if (near) {
      term.concepts = [near.concept];
      term.known = true;
      approximate.add(term.raw);
    }
  }

  const concepts = new Set(terms.flatMap((term) => term.concepts));
  const expansions: QueryExpansion[] = [];
  for (const concept of concepts) {
    const entries = vocabulary.filter((entry) => entry.concept === concept);
    const matched = terms.find((term) => term.concepts.includes(concept))!;
    expansions.push({
      concept,
      matched: matched.raw,
      terms: [...new Set(entries.map((entry) => entry.term))],
      lexemes: [...new Set(entries.flatMap((entry) => simpleLexemes(entry.term)))],
      approximate: approximate.has(matched.raw),
    });
  }

  return {
    terms,
    expansions,
    hasFreeText: terms.some((term) => !term.known),
  };
}

/** Closest vocabulary surface form within a conservative trigram bound. */
function nearestConcept(
  word: string,
  vocabulary: readonly VocabularyTerm[],
): VocabularyTerm | null {
  let best: { entry: VocabularyTerm; similarity: number } | null = null;
  for (const entry of vocabulary) {
    for (const candidate of entry.term.toLowerCase().split(/\s+/)) {
      if (candidate.length < 4) continue;
      const similarity = trigramSimilarity(word, candidate);
      if (similarity >= 0.55 && (!best || similarity > best.similarity)) {
        best = { entry, similarity };
      }
    }
  }
  return best?.entry ?? null;
}

/** Dice coefficient over padded trigrams, the same shape pg_trgm uses. */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const trigram of left) if (right.has(trigram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value.toLowerCase()} `;
  const result = new Set<string>();
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return result;
}
