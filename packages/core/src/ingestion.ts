// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { lookup } from "node:dns/promises";
import { err, ok, type CoreError, type Result } from "./errors";
import { isAuthorized, type Principal } from "./principal";
import { canonicalizeAttributeValue } from "./attribute-values";
import { fetchBounds, type FetchBounds } from "./ingestion/bounds";
import {
  retrievePage,
  type DestinationResolver,
  type FetchFailure,
  type PageFetcher,
  type PermittedSource,
  type SourcePolicy,
} from "./ingestion/retrieval";

export type { PageFetcher, PermittedSource, SourcePolicy } from "./ingestion/retrieval";
export type { FetchBounds } from "./ingestion/bounds";

export interface IngestionDependencies {
  fetch?: PageFetcher;
  sourcePolicy?: SourcePolicy;
  now?: () => Date;
  /** Resolves every destination before a connection; injectable for deterministic tests. */
  resolve?: DestinationResolver;
  /** Timeout, size and redirect limits for one page retrieval. */
  bounds?: Partial<FetchBounds>;
}

/**
 * Maps a retrieval refusal onto the core error vocabulary. URL refusals keep
 * their own kinds so a caller can tell "never allowed" from "the source failed".
 */
function refusal(outcome: { failure: FetchFailure; sourceUrl: string; url: string; status?: number }): CoreError {
  if (outcome.failure === "unsafe-url") {
    return { kind: "unsafe-url", message: "Only public HTTPS URLs without credentials or private destinations are allowed" };
  }
  if (outcome.failure === "not-permitted") return { kind: "source-not-permitted", url: outcome.url };
  return { kind: "source-fetch-failed", classification: outcome.failure, sourceUrl: outcome.sourceUrl, url: outcome.url, ...(outcome.status === undefined ? {} : { status: outcome.status }) };
}

/** The host a submitted URL names, or null when it is not a parseable URL. */
function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface IngestedPage {
  variantId: string;
  offerId: string;
  evidenceId: string;
}

type StructuredProduct = {
  name: string;
  manufacturer: string | null;
  category: string | null;
  gtin: string | null;
  mpn: string | null;
  sku: string | null;
  attributes: Record<string, unknown>;
  price: string;
  currency: string;
  seller: string | null;
  condition: "new" | "refurbished";
};

/** What one page said, or why it cannot be admitted. Never a partial product. */
type ParsedPage =
  | { kind: "product"; product: StructuredProduct }
  | { kind: "ambiguous"; message: string }
  | { kind: "incomplete"; message: string };

/** GTIN-8/12/13/14 share a check digit; an unchecked string is not an identifier. */
function validGtin(value: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function propertyValue(product: Record<string, unknown>): Record<string, unknown> {
  const values = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  return Object.fromEntries(values.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (typeof value.name !== "string" || value.value === undefined) return [];
    const rawUnit = typeof value.unitCode === "string" ? value.unitCode : typeof value.unitText === "string" ? value.unitText : null;
    return [[value.name, rawUnit ? { value: value.value, unit: rawUnit } : value.value]];
  }));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Reads the first complete Product/Offer block. A page that names two different
 * identifiers is ambiguous: choosing one would merge the wrong configurations,
 * so it is reported instead of guessed. A page whose required fields are gone
 * is incomplete: the caller must not let a layout change erase known facts.
 */
function parseProduct(html: string): ParsedPage {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script[1]!);
      const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
      const product = values.find((value) => value && typeof value === "object" && String((value as Record<string, unknown>)["@type"]).includes("Product")) as Record<string, unknown> | undefined;
      if (!product) continue;
      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      const offer = offers.find((value) => value && typeof value === "object") as Record<string, unknown> | undefined;
      const name = text(product.name);
      if (!name) return { kind: "incomplete", message: "The product block has no name" };
      const price = offer && text(offer.price);
      const currency = offer && text(offer.priceCurrency);
      if (!price || !currency || !/^\d+(?:\.\d{1,2})?$/.test(price) || !/^[A-Z]{3}$/.test(currency)) {
        return { kind: "incomplete", message: "The product block has no complete price and currency" };
      }

      const declared = [text(product.gtin13), text(product.gtin), text(product.gtin12), text(product.gtin14), text(product.gtin8)]
        .filter((value): value is string => value !== null);
      const gtins = [...new Set(declared)];
      if (gtins.length > 1) {
        return { kind: "ambiguous", message: `The product block declares ${gtins.length} different GTINs` };
      }
      const gtin = gtins[0] ?? null;
      if (gtin !== null && !validGtin(gtin)) {
        return { kind: "incomplete", message: "The product block declares a GTIN that fails its check digit" };
      }

      const brand = product.brand && typeof product.brand === "object" ? text((product.brand as Record<string, unknown>).name) : text(product.brand);
      const sellerObject = offer?.seller;
      const seller = sellerObject && typeof sellerObject === "object" ? text((sellerObject as Record<string, unknown>).name) : text(sellerObject);
      const condition = String(offer?.itemCondition ?? "").toLowerCase().includes("refurbished") ? "refurbished" : "new";
      return { kind: "product", product: { name, manufacturer: brand, category: text(product.category), gtin, mpn: text(product.mpn), sku: text(product.sku) ?? text(offer?.sku), attributes: propertyValue(product), price, currency, seller, condition } };
    } catch { /* ignore malformed JSON-LD blocks */ }
  }
  return { kind: "incomplete", message: "No complete Product JSON-LD offer was found" };
}

function excerpt(html: string): string { return html.replace(/\s+/g, " ").trim().slice(0, 2_000); }

/** Names differ in case, punctuation and spacing between listings; identity does not. */
function comparableName(value: string): string {
  // Strip accents first, then punctuation, so "Café-Sound 1" and "cafe sound 1" agree.
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Two listings agree only if their product names are not visibly different. */
function sameProduct(a: string, b: string): boolean {
  return comparableName(a) === comparableName(b);
}

/**
 * Compares the configuration a page declares with what the catalogue already
 * holds. Returns the conflicting keys; an empty array means agreement.
 * Canonicalisation happens first so "68.58 cm" and "27 in" are the same value
 * rather than a false conflict.
 */
function conflictingAttributes(
  existing: Record<string, unknown>,
  declared: Record<string, unknown>,
  canonicalize: (rawName: string, value: unknown) => { key: string; value: unknown } | null,
): string[] {
  return Object.entries(declared).flatMap(([rawName, value]) => {
    const canonical = canonicalize(rawName, value);
    const key = canonical?.key ?? rawName;
    const next = canonical ? canonical.value : value;
    if (!(key in existing)) return [];
    const current = existing[key];
    if (typeof current === "number" && typeof next === "number") return current === next ? [] : [key];
    return JSON.stringify(current) === JSON.stringify(next) ? [] : [key];
  });
}

function normalizedAttributeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** What a source check may record; a success never clears a failure and vice versa. */
type SourceOutcome =
  | { kind: "success"; host: string; retailerName: string; at: Date }
  | { kind: "failure"; host: string; retailerName: string | null; at: Date; classification: SourceFailure };

export type SourceFailure = "redirect" | "challenge" | "http" | "network" | "size" | "timeout" | "extraction" | "identity";

/**
 * One row per host. Written outside the catalogue transaction: a source that
 * was blocked or broken must stay visible even though nothing was admitted.
 *
 * Source state is bookkeeping, so a failure to record it never changes the
 * outcome the caller sees — a valid page must not be rejected because the
 * source row could not be written.
 */
async function recordSourceOutcome(db: Knex, outcome: SourceOutcome): Promise<void> {
  const values = outcome.kind === "success"
    ? { last_success_at: outcome.at }
    : { last_failure_at: outcome.at, last_failure_classification: outcome.classification };
  const merged = { ...values, ...(outcome.retailerName ? { retailer_name: outcome.retailerName } : {}) };
  try {
    await db("ingestion_sources")
      .insert({ host: outcome.host, retailer_name: outcome.retailerName, ...values })
      .onConflict("host")
      .merge(merged);
  } catch {
    // Deliberately swallowed: see the comment above.
  }
}

/** What a retrieval plus extraction produced, before anything is persisted. */
type PageCheck =
  | { ok: true; fetched: Extract<Awaited<ReturnType<typeof retrievePage>>, { ok: true }>; permitted: PermittedSource; retailerName: string; product: StructuredProduct }
  | { ok: false; error: CoreError };

export interface SourceCoverage {
  sourceUrl: string;
  /** Where the redirect chain ended; equals sourceUrl without redirects. */
  finalUrl: string | null;
  retailerName: string | null;
  /** How this page check ended. Only "extracted" covers the fields below. */
  outcome: "extracted" | SourceFailure;
  fields: {
    name: boolean;
    price: boolean;
    currency: boolean;
    /** Which reliable identifier the page carried, if any. */
    identifier: "gtin" | "mpn" | null;
    /** Retailer-local: never used to establish identity. */
    retailerSku: string | null;
    seller: string | null;
  };
  attributes: {
    declared: number;
    accepted: number;
    unresolved: number;
    /** Raw names the canonical vocabulary has no entry for. */
    unknown: string[];
  };
  /** Latest successful check of this host, from stored source state. */
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureClassification: SourceFailure | null;
}

export interface Ingestion {
  /** Admits one permitted page into the catalogue; refuses anything it cannot fully understand. */
  ingestProductPage(principal: Principal, sourceUrl: string): Promise<Result<IngestedPage>>;
  /** Reports what a submitted page covers without admitting anything. */
  reportSourceCoverage(principal: Principal, sourceUrl: string): Promise<Result<SourceCoverage>>;
}

export function createIngestion(db: Knex, deps: IngestionDependencies = {}): Ingestion {
  const fetchPage = deps.fetch ?? ((url: string, init?: { signal?: AbortSignal }) => fetch(url, init));
  const policy = deps.sourcePolicy ?? (() => null);
  const now = deps.now ?? (() => new Date());
  const resolve = deps.resolve ?? (async (hostname: string) => (await lookup(hostname, { all: true })).map((entry) => entry.address));
  const bounds = fetchBounds(deps.bounds);
  const retrieve = (sourceUrl: string) => retrievePage(sourceUrl, { fetch: fetchPage, resolve, policy, bounds });

  /**
   * Retrieves and parses one page. Every refusal is recorded against its host
   * and returned as an error; nothing here writes catalogue rows, so a caller
   * cannot persist a page it did not fully understand.
   */
  async function checkPage(sourceUrl: string): Promise<PageCheck> {
    const fetched = await retrieve(sourceUrl);
    if (!fetched.ok) {
      const host = hostOf(fetched.sourceUrl);
      // A locally refused URL never reached a source, so it is not a source failure.
      if (host && fetched.failure !== "unsafe-url" && fetched.failure !== "not-permitted") {
        await recordSourceOutcome(db, { kind: "failure", host, retailerName: policy(new URL(fetched.sourceUrl))?.retailerName ?? null, at: now(), classification: fetched.failure });
      }
      return { ok: false, error: refusal(fetched) };
    }
    // Retrieval only returns ok once the final URL passed policy, so its source
    // is known here; the non-null assertion states that invariant rather than
    // inventing a fallback source that would never be the real one.
    const permitted = policy(new URL(fetched.finalUrl))!;
    const retailerName = permitted.retailerName;
    const parsed = parseProduct(fetched.html);
    if (parsed.kind !== "product") {
      // Neither case may touch the catalogue: an ambiguous page could merge the
      // wrong variant and an incomplete one could erase known facts.
      await recordSourceOutcome(db, { kind: "failure", host: new URL(fetched.finalUrl).hostname, retailerName, at: now(), classification: "extraction" });
      return { ok: false, error: { kind: "extraction-failed", message: parsed.message } };
    }
    return {
      ok: true,
      fetched,
      retailerName,
      product: parsed.product,
      permitted,
    };
  }

  /** Canonical attribute lookup; shared by admission and coverage reporting. */
  async function attributeVocabulary(connection: Knex | Knex.Transaction) {
    const attributeRows = await connection("catalogue_attributes").select("id", "key", "value_type", "unit");
    const synonyms = await connection("catalogue_attribute_synonyms").select("attribute_id", "synonym");
    const byName = new Map(attributeRows.map((attribute) => [normalizedAttributeName(attribute.key), attribute]));
    for (const synonym of synonyms) {
      const attribute = attributeRows.find((candidate) => candidate.id === synonym.attribute_id);
      if (attribute) byName.set(normalizedAttributeName(synonym.synonym), attribute);
    }
    /** Raw page name to canonical key/value; null when the vocabulary has no match. */
    const canonicalize = (rawName: string, value: unknown) => {
      const attribute = byName.get(normalizedAttributeName(rawName));
      if (!attribute) return null;
      const canonical = canonicalizeAttributeValue({ key: attribute.key, valueType: attribute.value_type, unit: attribute.unit }, value);
      return canonical === null || canonical === undefined ? null : { key: attribute.key, value: canonical, attributeId: attribute.id as string };
    };
    return { canonicalize };
  }

  async function ingestProductPage(principal: Principal, sourceUrl: string): Promise<Result<IngestedPage>> {
    if (!isAuthorized(principal, "catalogue.ingest")) return err({ kind: "forbidden", capability: "catalogue.ingest" });
    const checked = await checkPage(sourceUrl);
    if (!checked.ok) return err(checked.error);
    const { fetched, permitted, retailerName, product } = checked;
    const html = fetched.html;
    const host = new URL(fetched.finalUrl).hostname;

    const observedAt = now();
    const result = await db.transaction(async (trx) => {
      const existingEvidence = await trx("source_evidence").where({ source_url: sourceUrl }).first();
      const [evidence] = existingEvidence ? await trx("source_evidence").where({ id: existingEvidence.id }).update({ final_url: fetched.finalUrl, excerpt: excerpt(html), observed_at: observedAt }).returning("id") : await trx("source_evidence").insert({ source_url: sourceUrl, final_url: fetched.finalUrl, excerpt: excerpt(html), observed_at: observedAt }).returning("id");
      const evidenceId = evidence.id as string;
      let retailer = await trx("retailers").where({ base_url: permitted.baseUrl }).first();
      if (!retailer) [retailer] = await trx("retailers").insert({ name: permitted.retailerName, base_url: permitted.baseUrl }).returning("*");

      const { canonicalize } = await attributeVocabulary(trx);

      const identifier = product.gtin ?? product.mpn;
      // A GTIN is global; an MPN only narrows a match once the product name agrees.
      let variant = product.gtin
        ? await trx("variants").where({ gtin: product.gtin }).first()
        : product.mpn
          ? (await trx("variants").where({ manufacturer_part_number: product.mpn }).select("variants.*", "products.name as product_name").join("products", "products.id", "variants.product_id")).find((candidate) => sameProduct(candidate.product_name, product.name))
          : undefined;

      if (variant) {
        const existingProduct = await trx("products").where({ id: variant.product_id }).first();
        const conflicts = [
          ...(existingProduct && !sameProduct(existingProduct.name, product.name) ? ["product.name"] : []),
          ...conflictingAttributes(variant.attributes ?? {}, product.attributes, canonicalize),
        ];
        if (conflicts.length) {
          // Every attribute stays as an unresolved claim, so the disagreement is
          // reviewable instead of silently replacing a known configuration.
          for (const [rawName, value] of Object.entries(product.attributes)) {
            await trx("source_claims").insert({
              evidence_id: evidenceId,
              variant_id: variant.id,
              field: `attribute.${rawName}`,
              raw_name: rawName,
              value: JSON.stringify(value),
              observed_at: observedAt,
              mapping_status: "unresolved",
            }).onConflict(["evidence_id", "field"]).merge({
              value: JSON.stringify(value),
              observed_at: observedAt,
              mapping_status: "unresolved",
              canonical_attribute_id: null,
            });
          }
          return err({ kind: "identity-conflict", identifier: identifier!, conflicting: conflicts });
        }
      }

      let productRow = variant ? await trx("products").where({ id: variant.product_id }).first() : await trx("products").where({ name: product.name, manufacturer: product.manufacturer }).first();
      if (!productRow) [productRow] = await trx("products").insert({ name: product.name, manufacturer: product.manufacturer, category: product.category }).returning("*");
      const acceptedAttributes: Record<string, unknown> = {};
      for (const [rawName, value] of Object.entries(product.attributes)) {
        const canonical = canonicalize(rawName, value);
        if (canonical) acceptedAttributes[canonical.key] = canonical.value;
      }
      if (!variant) [variant] = await trx("variants").insert({ product_id: productRow.id, name: product.name, gtin: product.gtin, manufacturer_part_number: product.mpn, attributes: JSON.stringify(acceptedAttributes) }).returning("*");
      let offer = await trx("offers").where({ retailer_id: retailer.id, url: sourceUrl }).first();
      if (!offer) [offer] = await trx("offers").insert({ variant_id: variant.id, retailer_id: retailer.id, url: sourceUrl, condition: product.condition, retailer_sku: product.sku, seller_name: product.seller }).returning("*");
      // Only a complete, agreeing extraction replaces an observation, and the
      // replacement happens inside this transaction.
      await trx("price_observations").where({ offer_id: offer.id, source_kind: "retailer_page" }).del();
      await trx("price_observations").insert({ offer_id: offer.id, amount: product.price, currency: product.currency, shipping_amount: "0.00", vat_included: true, source_kind: "retailer_page", observed_at: observedAt });
      const claims = [["product.name", product.name, "product_id"], ["variant.identifiers", { gtin: product.gtin, manufacturerPartNumber: product.mpn }, "variant_id"], ["offer", { retailerSku: product.sku, seller: product.seller, price: product.price, currency: product.currency }, "offer_id"]] as const;
      for (const [field, value, target] of claims) await trx("source_claims").insert({ evidence_id: evidenceId, field, value: JSON.stringify(value), observed_at: observedAt, [target]: target === "product_id" ? productRow.id : target === "variant_id" ? variant.id : offer.id }).onConflict(["evidence_id", "field"]).merge({ value: JSON.stringify(value), observed_at: observedAt });
      for (const [rawName, value] of Object.entries(product.attributes)) {
        const canonical = canonicalize(rawName, value);
        await trx("source_claims").insert({
          evidence_id: evidenceId, variant_id: variant.id, field: `attribute.${rawName}`, raw_name: rawName,
          value: JSON.stringify(value), observed_at: observedAt,
          mapping_status: canonical ? "accepted" : "unresolved", canonical_attribute_id: canonical?.attributeId ?? null,
        }).onConflict(["evidence_id", "field"]).merge({ value: JSON.stringify(value), observed_at: observedAt, mapping_status: canonical ? "accepted" : "unresolved", canonical_attribute_id: canonical?.attributeId ?? null });
      }
      return ok({ variantId: variant.id, offerId: offer.id, evidenceId });
    });
    if (!result.ok && result.error.kind === "identity-conflict") {
      await recordSourceOutcome(db, { kind: "failure", host, retailerName, at: observedAt, classification: "identity" });
      return result;
    }
    if (!result.ok) return result;
    await recordSourceOutcome(db, { kind: "success", host, retailerName, at: observedAt });
    return result;
  }

  /**
   * Reports what a submitted page covers: which required fields and claims the
   * extraction produced, which claims the canonical vocabulary could not accept,
   * and what is already known about the source. It performs the same bounded
   * retrieval as ingestion but admits nothing.
   */
  async function reportSourceCoverage(principal: Principal, sourceUrl: string): Promise<Result<SourceCoverage>> {
    if (!isAuthorized(principal, "catalogue.ingest")) return err({ kind: "forbidden", capability: "catalogue.ingest" });
    const checked = await checkPage(sourceUrl);
    const host = hostOf(checked.ok ? checked.fetched.finalUrl : sourceUrl);
    const source = host ? await db("ingestion_sources").where({ host }).first() : undefined;
    const stored = {
      lastSuccessAt: source?.last_success_at ? new Date(source.last_success_at).toISOString() : null,
      lastFailureAt: source?.last_failure_at ? new Date(source.last_failure_at).toISOString() : null,
      lastFailureClassification: (source?.last_failure_classification ?? null) as SourceFailure | null,
    };

    if (!checked.ok) {
      const refusalKind = checked.error.kind;
      // An unsafe or unpermitted URL is not a source outcome to report on.
      if (refusalKind === "unsafe-url") return err(checked.error);
      if (refusalKind === "source-not-permitted") return err(checked.error);
      return ok({
        sourceUrl,
        finalUrl: null,
        retailerName: source?.retailer_name ?? null,
        outcome: refusalKind === "extraction-failed" ? "extraction" : (checked.error as { classification: SourceFailure }).classification,
        fields: { name: false, price: false, currency: false, identifier: null, retailerSku: null, seller: null },
        attributes: { declared: 0, accepted: 0, unresolved: 0, unknown: [] },
        ...stored,
      });
    }

    const { canonicalize } = await attributeVocabulary(db);
    const declared = Object.entries(checked.product.attributes);
    const canonical = declared.map(([rawName, value]) => ({ rawName, value, accepted: canonicalize(rawName, value) }));
    return ok({
      sourceUrl,
      finalUrl: checked.fetched.finalUrl,
      retailerName: checked.retailerName,
      outcome: "extracted",
      fields: {
        name: checked.product.name.trim().length > 0,
        price: /^\d+(?:\.\d{1,2})?$/.test(checked.product.price),
        currency: /^[A-Z]{3}$/.test(checked.product.currency),
        identifier: checked.product.gtin ? "gtin" : checked.product.mpn ? "mpn" : null,
        retailerSku: checked.product.sku,
        seller: checked.product.seller,
      },
      attributes: {
        declared: declared.length,
        accepted: canonical.filter((attribute) => attribute.accepted !== null).length,
        unresolved: canonical.filter((attribute) => attribute.accepted === null).length,
        unknown: canonical.filter((attribute) => attribute.accepted === null).map((attribute) => attribute.rawName),
      },
      ...stored,
    });
  }

  return { ingestProductPage, reportSourceCoverage };
}
