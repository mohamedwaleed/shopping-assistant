// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { lookup } from "node:dns/promises";
import { err, ok, type Result } from "./errors";
import { isAuthorized, type Principal } from "./principal";
import { canonicalizeAttributeValue } from "./attribute-values";

export interface PermittedSource {
  retailerName: string;
  baseUrl: string;
  /** Exact hostname or a subdomain suffix such as `.example.nl`. */
  hosts: readonly string[];
}

export type SourcePolicy = (url: URL) => PermittedSource | null;
export type PageFetcher = (url: string) => Promise<Response>;

export interface IngestionDependencies {
  fetch?: PageFetcher;
  sourcePolicy?: SourcePolicy;
  now?: () => Date;
  /** Resolves every destination before a connection; injectable for deterministic tests. */
  resolve?: (hostname: string) => Promise<readonly string[]>;
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

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);

function safeUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || BLOCKED_HOSTS.has(url.hostname)) return null;
  if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd)/i.test(url.hostname)) return null;
  return url;
}

function permittedHost(url: URL, source: PermittedSource): boolean {
  return source.hosts.some((host) => url.hostname === host || (host.startsWith(".") && url.hostname.endsWith(host)));
}

function publicAddress(address: string): boolean {
  return !/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd)/i.test(address);
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

function parseProduct(html: string): StructuredProduct | null {
  const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script[1]!);
      const values = Array.isArray(parsed) ? parsed : Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed];
      const product = values.find((value) => value && typeof value === "object" && String((value as Record<string, unknown>)["@type"]).includes("Product")) as Record<string, unknown> | undefined;
      if (!product) continue;
      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      const offer = offers.find((value) => value && typeof value === "object") as Record<string, unknown> | undefined;
      const name = text(product.name); const price = offer && text(offer.price); const currency = offer && text(offer.priceCurrency);
      if (!name || !price || !currency || !/^\d+(?:\.\d{1,2})?$/.test(price) || !/^[A-Z]{3}$/.test(currency)) return null;
      const brand = product.brand && typeof product.brand === "object" ? text((product.brand as Record<string, unknown>).name) : text(product.brand);
      const sellerObject = offer?.seller;
      const seller = sellerObject && typeof sellerObject === "object" ? text((sellerObject as Record<string, unknown>).name) : text(sellerObject);
      const condition = String(offer?.itemCondition ?? "").toLowerCase().includes("refurbished") ? "refurbished" : "new";
      return { name, manufacturer: brand, category: text(product.category), gtin: text(product.gtin13) ?? text(product.gtin), mpn: text(product.mpn), sku: text(product.sku) ?? text(offer?.sku), attributes: propertyValue(product), price, currency, seller, condition };
    } catch { /* ignore malformed JSON-LD blocks */ }
  }
  return null;
}

function excerpt(html: string): string { return html.replace(/\s+/g, " ").trim().slice(0, 2_000); }

function normalizedAttributeName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function createIngestion(db: Knex, deps: IngestionDependencies = {}) {
  const fetchPage = deps.fetch ?? fetch;
  const policy = deps.sourcePolicy ?? (() => null);
  const now = deps.now ?? (() => new Date());
  const resolve = deps.resolve ?? (async (hostname: string) => (await lookup(hostname, { all: true })).map((entry) => entry.address));

  return async function ingestProductPage(principal: Principal, sourceUrl: string): Promise<Result<IngestedPage>> {
    if (!isAuthorized(principal, "catalogue.ingest")) return err({ kind: "forbidden", capability: "catalogue.ingest" });
    const initialUrl = safeUrl(sourceUrl);
    if (!initialUrl) return err({ kind: "unsafe-url", message: "Only public HTTPS URLs without credentials are allowed" });
    let current: URL = initialUrl;
    const permitted = policy(current);
    if (!permitted || !permittedHost(current, permitted)) return err({ kind: "source-not-permitted", url: current.toString() });
    try { const destinations = await resolve(current.hostname); if (!destinations.length || !destinations.every(publicAddress)) return err({ kind: "unsafe-url", message: "Source resolves to a private network destination" }); }
    catch { return err({ kind: "source-fetch-failed", classification: "network" }); }
    let response: Response;
    for (let redirects = 0; ; redirects += 1) {
      try { response = await fetchPage(current.toString()); } catch { return err({ kind: "source-fetch-failed", classification: "network" }); }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      const next: URL | null = location ? safeUrl(new URL(location, current).toString()) : null;
      if (!next || redirects >= 3 || !permittedHost(next, permitted)) return err({ kind: "source-fetch-failed", classification: "redirect" });
      try { const destinations = await resolve(next.hostname); if (!destinations.length || !destinations.every(publicAddress)) return err({ kind: "source-fetch-failed", classification: "redirect" }); }
      catch { return err({ kind: "source-fetch-failed", classification: "redirect" }); }
      current = next;
    }
    if (!response.ok) return err({ kind: "source-fetch-failed", classification: "http" });
    const html = await response.text();
    if (/captcha|verify you are human|security checkpoint|access denied/i.test(html)) return err({ kind: "source-fetch-failed", classification: "challenge" });
    const product = parseProduct(html);
    if (!product) return err({ kind: "extraction-failed", message: "No complete Product JSON-LD offer was found" });

    const observedAt = now();
    return db.transaction(async (trx) => {
      const existingEvidence = await trx("source_evidence").where({ source_url: sourceUrl }).first();
      const [evidence] = existingEvidence ? await trx("source_evidence").where({ id: existingEvidence.id }).update({ final_url: current!.toString(), excerpt: excerpt(html), observed_at: observedAt }).returning("id") : await trx("source_evidence").insert({ source_url: sourceUrl, final_url: current!.toString(), excerpt: excerpt(html), observed_at: observedAt }).returning("id");
      const evidenceId = evidence.id as string;
      let retailer = await trx("retailers").where({ base_url: permitted.baseUrl }).first();
      if (!retailer) [retailer] = await trx("retailers").insert({ name: permitted.retailerName, base_url: permitted.baseUrl }).returning("*");
      const identifier = product.gtin ?? product.mpn;
      let variant = identifier ? await trx("variants").where(product.gtin ? { gtin: product.gtin } : { manufacturer_part_number: product.mpn }).first() : undefined;
      if (variant && JSON.stringify(variant.attributes ?? {}) !== JSON.stringify(product.attributes)) {
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
        return err({ kind: "identity-conflict", identifier: identifier! });
      }
      let productRow = variant ? await trx("products").where({ id: variant.product_id }).first() : await trx("products").where({ name: product.name, manufacturer: product.manufacturer }).first();
      if (!productRow) [productRow] = await trx("products").insert({ name: product.name, manufacturer: product.manufacturer, category: product.category }).returning("*");
      const attributeRows = await trx("catalogue_attributes").select("id", "key", "value_type", "unit");
      const synonyms = await trx("catalogue_attribute_synonyms").select("attribute_id", "synonym");
      const byName = new Map(attributeRows.map((attribute) => [normalizedAttributeName(attribute.key), attribute]));
      for (const synonym of synonyms) {
        const attribute = attributeRows.find((candidate) => candidate.id === synonym.attribute_id);
        if (attribute) byName.set(normalizedAttributeName(synonym.synonym), attribute);
      }
      const acceptedAttributes: Record<string, unknown> = {};
      for (const [rawName, value] of Object.entries(product.attributes)) {
        const attribute = byName.get(normalizedAttributeName(rawName));
        const canonical = attribute && canonicalizeAttributeValue({ key: attribute.key, valueType: attribute.value_type, unit: attribute.unit }, value);
        if (canonical !== null && canonical !== undefined) acceptedAttributes[attribute!.key] = canonical;
      }
      if (!variant) [variant] = await trx("variants").insert({ product_id: productRow.id, name: product.name, gtin: product.gtin, manufacturer_part_number: product.mpn, attributes: JSON.stringify(acceptedAttributes) }).returning("*");
      let offer = await trx("offers").where({ retailer_id: retailer.id, url: sourceUrl }).first();
      if (!offer) [offer] = await trx("offers").insert({ variant_id: variant.id, retailer_id: retailer.id, url: sourceUrl, condition: product.condition, retailer_sku: product.sku, seller_name: product.seller }).returning("*");
      await trx("price_observations").where({ offer_id: offer.id, source_kind: "retailer_page" }).del();
      await trx("price_observations").insert({ offer_id: offer.id, amount: product.price, currency: product.currency, shipping_amount: "0.00", vat_included: true, source_kind: "retailer_page", observed_at: observedAt });
      const claims = [["product.name", product.name, "product_id"], ["variant.identifiers", { gtin: product.gtin, manufacturerPartNumber: product.mpn }, "variant_id"], ["offer", { retailerSku: product.sku, seller: product.seller, price: product.price, currency: product.currency }, "offer_id"]] as const;
      for (const [field, value, target] of claims) await trx("source_claims").insert({ evidence_id: evidenceId, field, value: JSON.stringify(value), observed_at: observedAt, [target]: target === "product_id" ? productRow.id : target === "variant_id" ? variant.id : offer.id }).onConflict(["evidence_id", "field"]).merge({ value: JSON.stringify(value), observed_at: observedAt });
      for (const [rawName, value] of Object.entries(product.attributes)) {
        const attribute = byName.get(normalizedAttributeName(rawName));
        const canonical = attribute && canonicalizeAttributeValue({ key: attribute.key, valueType: attribute.value_type, unit: attribute.unit }, value);
        await trx("source_claims").insert({
          evidence_id: evidenceId, variant_id: variant.id, field: `attribute.${rawName}`, raw_name: rawName,
          value: JSON.stringify(value), observed_at: observedAt,
          mapping_status: canonical === null || canonical === undefined ? "unresolved" : "accepted", canonical_attribute_id: canonical === null || canonical === undefined ? null : attribute!.id,
        }).onConflict(["evidence_id", "field"]).merge({ value: JSON.stringify(value), observed_at: observedAt, mapping_status: canonical === null || canonical === undefined ? "unresolved" : "accepted", canonical_attribute_id: canonical === null || canonical === undefined ? null : attribute!.id });
      }
      return ok({ variantId: variant.id, offerId: offer.id, evidenceId });
    });
  };
}
