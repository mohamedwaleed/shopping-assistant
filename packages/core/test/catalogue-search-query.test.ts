// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  analyseQuery,
  MAX_SEARCH_TERMS,
  simpleLexemes,
  trigramSimilarity,
  type VocabularyTerm,
} from "../src/index";

// The vocabulary the migration seeds, reduced to the entries these cases need.
// Language is deliberately NOT used to pick a dictionary: the catalogue and the
// shopper may each be in either language.
const vocabulary: VocabularyTerm[] = [
  { concept: "monitor", term: "monitor", language: "en" },
  { concept: "monitor", term: "monitors", language: "en" },
  { concept: "monitor", term: "monitoren", language: "nl" },
  { concept: "monitor", term: "beeldscherm", language: "nl" },
  { concept: "kettle", term: "kettle", language: "en" },
  { concept: "kettle", term: "waterkoker", language: "nl" },
  { concept: "refrigerator", term: "fridge", language: "en" },
  { concept: "refrigerator", term: "koelkast", language: "nl" },
  { concept: "colour", term: "black", language: "en" },
  { concept: "colour", term: "zwart", language: "nl" },
  { concept: "colour", term: "zwarte", language: "nl" },
];

describe("catalogue query analysis", () => {
  it("folds a word the way PostgreSQL's simple dictionary does", () => {
    expect(simpleLexemes("Waterkoker")).toEqual(["waterkoker"]);
    expect(simpleLexemes("27-inch")).toEqual(["27", "inch"]);
    expect(simpleLexemes("USB-C, 90W")).toEqual(["usb", "c", "90w"]);
    expect(simpleLexemes("---")).toEqual([]);
  });

  it("reaches an English concept from Dutch wording and the reverse", () => {
    const dutch = analyseQuery("koelkast", vocabulary);
    expect(dutch.expansions).toEqual([
      expect.objectContaining({ concept: "refrigerator", matched: "koelkast", approximate: false }),
    ]);
    expect(dutch.expansions[0]!.lexemes).toEqual(expect.arrayContaining(["fridge", "koelkast"]));

    const english = analyseQuery("fridge", vocabulary);
    expect(english.expansions[0]!.lexemes).toEqual(
      expect.arrayContaining(["fridge", "koelkast"]),
    );
  });

  it("keeps a word that exists in both languages as one concept", () => {
    const analysed = analyseQuery("monitor", vocabulary);
    expect(analysed.expansions).toHaveLength(1);
    expect(analysed.expansions[0]!.terms).toEqual(
      expect.arrayContaining(["monitor", "monitoren", "beeldscherm"]),
    );
  });

  it("marks a misspelling approximate and still reaches the concept", () => {
    const analysed = analyseQuery("monitr", vocabulary);
    expect(analysed.terms[0]).toMatchObject({ raw: "monitr", known: true });
    expect(analysed.expansions).toEqual([
      expect.objectContaining({ concept: "monitor", matched: "monitr", approximate: true }),
    ]);
  });

  it("does not invent a concept for an unknown word", () => {
    const analysed = analyseQuery("zalmkleur", vocabulary);
    expect(analysed.terms[0]).toMatchObject({ raw: "zalmkleur", known: false });
    expect(analysed.expansions).toEqual([]);
    expect(analysed.hasFreeText).toBe(true);
  });

  it("handles a mixed-language query in one pass", () => {
    const analysed = analyseQuery("zwarte 27 inch monitor", vocabulary);
    expect(analysed.terms.map((term) => term.raw)).toEqual(["zwarte", "27", "inch", "monitor"]);
    expect(analysed.expansions.map((expansion) => expansion.concept).sort()).toEqual([
      "colour",
      "monitor",
    ]);
    // "27" and "inch" are not in this reduced vocabulary, so they stay literal.
    expect(analysed.terms.find((term) => term.raw === "27")?.known).toBe(false);
  });

  it("bounds the number of terms it will analyse", () => {
    const analysed = analyseQuery(
      Array.from({ length: MAX_SEARCH_TERMS + 5 }, (_, index) => `word${index}`).join(" "),
      vocabulary,
    );
    expect(analysed.terms).toHaveLength(MAX_SEARCH_TERMS);
  });

  it("measures trigram similarity the way pg_trgm does", () => {
    expect(trigramSimilarity("monitor", "monitor")).toBe(1);
    expect(trigramSimilarity("monitr", "monitor")).toBeGreaterThan(0.55);
    expect(trigramSimilarity("koelkast", "fridge")).toBeLessThan(0.2);
  });
});
