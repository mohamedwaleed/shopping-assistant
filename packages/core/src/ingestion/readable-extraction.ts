// SPDX-License-Identifier: AGPL-3.0-or-later
import { REQUIRED_PRODUCT_FIELDS, type AdapterFields, type RequiredProductField } from "./source-adapters";
import type { ResolvedModel } from "../models/types";

/**
 * Readable content and evidence-linked model extraction (ticket 15).
 *
 * Two rules shape this module:
 *
 * 1. A page is reduced to readable text *with the page region each line came
 *    from*, so a model reading can point at where it saw a value.
 * 2. The model may only answer for fields the readable text actually contains.
 *    A required field it did not find stays missing; it is never filled from the
 *    model's general knowledge about the product. That refusal is what keeps an
 *    extraction from inventing an offer.
 */

/** Readable text with the selector of the page region it came from. */
export interface ReadableContent {
  lines: Array<{ selector: string; text: string }>;
  /** True when the page had no readable body text worth reading. */
  empty: boolean;
}

const MAX_LINE_LENGTH = 240;
const MAX_LINES = 120;

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    euro: "€",
    pound: "£",
    hellip: "…",
    ndash: "–",
    mdash: "—",
  };
  return value
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/**
 * Reduce a page to readable lines. Headings, list items, table rows and
 * definition entries are kept individually because that is where a retailer
 * states a specification; everything else is kept as paragraph text.
 */
export function readableContent(html: string): ReadableContent {
  const body = visible(html);
  const lines: ReadableContent["lines"] = [];
  const push = (selector: string, raw: string) => {
    const text = decodeEntities(raw.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (!text) return;
    lines.push({ selector, text: text.slice(0, MAX_LINE_LENGTH) });
  };

  const blocks = [...body.matchAll(
    /<(h[1-6]|li|tr|dt|dd|p)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
  )];
  for (const block of blocks) {
    const tag = block[1]!.toLowerCase();
    const selector = tag === "h1" || tag === "h2" ? tag : `${tag}:contains`;
    push(selector, block[2]!);
  }
  if (lines.length === 0) {
    // No block-level structure at all: keep the remaining text as one region.
    push("body", body);
  }

  return { lines: lines.slice(0, MAX_LINES), empty: lines.length === 0 };
}

/** What the model is given: readable text plus where each line came from. */
export function extractionPrompt(content: ReadableContent, sourceUrl: string): string {
  const region = content.lines.map((line, index) => `[${index}] ${line.text}`).join("\n");
  return [
    "Extract the product offer stated on this page.",
    `Source: ${sourceUrl}`,
    `Required fields: ${REQUIRED_PRODUCT_FIELDS.join(", ")}.`,
    "Answer only from the numbered lines. For every value you return, also return",
    "the index of the line you read it from. If a required field is not stated on",
    "the page, omit it; never supply a value from general knowledge.",
    "",
    region,
  ].join("\n");
}

/** One model reading, as the adapter returns it before it is checked. */
export interface ModelReading {
  fields: Partial<Record<keyof AdapterFields, unknown>>;
  /** The readable-line index each field was read from. */
  evidence: Partial<Record<keyof AdapterFields, unknown>>;
  attributes?: Record<string, unknown>;
}

export interface ModelExtractorRequest {
  content: ReadableContent;
  sourceUrl: string;
  /** Output-token bound for the single extraction call. */
  maxOutputTokens: number;
  /** The prompt built from the readable content; the adapter sends it as-is. */
  prompt: string;
  /** The resolved extraction model and the credential it must use. */
  model: ResolvedModel;
}

/**
 * The extraction model. Implemented by the web adapter through the pinned AI
 * SDK (docs/adr/0012); core never imports a provider SDK.
 */
export type ModelExtractor = (request: ModelExtractorRequest) => Promise<ModelReading | null>;

/** Bounds for one extraction call; the caller charges them to the budget. */
export const EXTRACTION_OUTPUT_TOKENS = 512;

export interface StructuredExtraction {
  fields: AdapterFields;
  attributes: Record<string, unknown>;
  evidence: Array<{ field: string; selector: string; value: string }>;
  requiredCoverage: { present: RequiredProductField[]; missing: RequiredProductField[] };
}

const NUMERIC_FIELDS = new Set<keyof AdapterFields>(["price"]);
const TEXT_FIELDS = new Set<keyof AdapterFields>([
  "name",
  "manufacturer",
  "category",
  "gtin",
  "mpn",
  "sku",
  "price",
  "currency",
  "seller",
]);

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** GTIN-8, -12, -13 and -14 are the only identifier lengths a catalogue stores. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * Whether a line states a value. A price is written in the page's own
 * formatting ("€ 79,99", "79.99", "1.299,00"), so it is compared as digits and
 * separators rather than as the normalized string the catalogue stores.
 */
function lineStates(line: string, field: string, value: string): boolean {
  if (field !== "price") return line.toLowerCase().includes(value.toLowerCase());
  const [whole = "", fraction = ""] = value.split(".");
  const compact = line.replace(/\s/g, "");
  // Dutch thousands grouping: "1.299,00" states 1299.00, not 1.299.
  const grouped = new RegExp(`(?:^|\\D)${whole}\\.\\d{3},\\d{1,2}(?:\\D|$)`).test(compact);
  if (grouped) return true;
  return new RegExp(`(?:^|\\D)${whole}(?:[.,]${fraction})?(?:\\D|$)`).test(compact);
}

/**
 * Accept a model reading only where the page supports it. A value with no
 * readable-line evidence, or with evidence that does not contain the value, is
 * dropped — and a dropped required field is reported missing rather than
 * guessed.
 */
export function verifyModelReading(
  reading: ModelReading,
  content: ReadableContent,
  required: readonly RequiredProductField[] = REQUIRED_PRODUCT_FIELDS,
): StructuredExtraction {
  const fields: AdapterFields = {};
  const attributes: Record<string, unknown> = {};
  const evidence: StructuredExtraction["evidence"] = [];

  const lineFor = (field: string): { selector: string; text: string } | null => {
    const index = reading.evidence?.[field as keyof AdapterFields];
    if (typeof index !== "number" || !Number.isInteger(index)) return null;
    return content.lines[index] ?? null;
  };

  for (const [field, raw] of Object.entries(reading.fields ?? {})) {
    if (!TEXT_FIELDS.has(field as keyof AdapterFields)) continue;
    const value = asText(raw);
    if (value === undefined) continue;
    if (field === "currency" && !/^[A-Z]{3}$/.test(value)) continue;
    if (field === "gtin" && !(/^\d+$/.test(value) && GTIN_LENGTHS.has(value.length))) continue;
    if (NUMERIC_FIELDS.has(field as keyof AdapterFields) && !/^\d+(?:\.\d{1,2})?$/.test(value)) continue;
    const line = lineFor(field);
    // The value must appear in the line the model pointed at. Without that,
    // the reading is unsupported and is not recorded.
    if (!line || !lineStates(line.text, field, value)) continue;
    (fields as Record<string, unknown>)[field] = value;
    evidence.push({ field, selector: line.selector, value });
  }
  // Condition is a classification, not a page value: it is only accepted when
  // the readable text says so.
  const conditionLine = lineFor("condition");
  if (conditionLine && /refurbish/i.test(conditionLine.text)) {
    fields.condition = "refurbished";
    evidence.push({ field: "condition", selector: conditionLine.selector, value: "refurbished" });
  }

  for (const [name, raw] of Object.entries(reading.attributes ?? {})) {
    const value = asText(raw) ?? (typeof raw === "number" ? String(raw) : undefined);
    if (value === undefined) continue;
    const line = content.lines.find((candidate) => candidate.text.toLowerCase().includes(value.toLowerCase()));
    if (!line) continue;
    attributes[name] = raw;
    evidence.push({ field: `attribute.${name}`, selector: line.selector, value });
  }

  const present = required.filter((field) => fields[field] !== undefined);
  return {
    fields,
    attributes,
    evidence,
    requiredCoverage: { present, missing: required.filter((field) => fields[field] === undefined) },
  };
}
