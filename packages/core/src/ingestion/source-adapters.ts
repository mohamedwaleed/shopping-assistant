// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Maintained source-specific adapters (ticket 15).
 *
 * Most permitted sources publish schema.org data and need no adapter. A small
 * number of Netherlands retailers do not, and for those a hand-reviewed adapter
 * reads one specific layout. An adapter is deliberately narrow: it knows one
 * page shape, it declares a version so a reading can be attributed, and it
 * reports the required fields it could not find rather than filling them in.
 * Adding a retailer means adding an adapter and a reviewed fixture — never
 * widening a generic pattern to catch every site.
 */

/** Fields a catalogue offer cannot be recorded without. */
export const REQUIRED_PRODUCT_FIELDS = ["name", "price", "currency", "gtin"] as const;
export type RequiredProductField = (typeof REQUIRED_PRODUCT_FIELDS)[number];

/** The normalized fields an adapter can contribute; absent means not found. */
export interface AdapterFields {
  name?: string;
  manufacturer?: string;
  category?: string;
  gtin?: string;
  mpn?: string;
  sku?: string;
  price?: string;
  currency?: string;
  seller?: string;
  condition?: "new" | "refurbished";
}

/** Where a value came from, so a claim can be traced to the page region. */
export interface FieldEvidence {
  field: string;
  selector: string;
  value: string;
}

export interface AdapterReading {
  fields: AdapterFields;
  attributes: Record<string, unknown>;
  evidence: FieldEvidence[];
  requiredCoverage: {
    present: RequiredProductField[];
    missing: RequiredProductField[];
  };
}

export interface AdapterPage {
  url: string;
  html: string;
}

export interface SourceAdapter {
  id: string;
  version: string;
  /** Exact hostnames this adapter was written and reviewed against. */
  hosts: readonly string[];
  requiredFields: readonly RequiredProductField[];
  read(page: AdapterPage): AdapterReading;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A price is only usable once it is a plain decimal string with two places. */
export function normalizePrice(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/[€$\s\u00a0]/g, "")
    .replace(/,-$/, "")
    .replace(/\./g, (match, offset: number, whole: string) =>
      // Dutch formatting uses "." for thousands and "," for decimals; a lone
      // "." is a decimal point, so only strip separators that group thousands.
      whole.indexOf(",") > offset ? "" : match,
    )
    .replace(",", ".");
  return /^\d+(?:\.\d{1,2})?$/.test(cleaned) ? cleaned : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)));
}

function plain(html: string): string | undefined {
  const stripped = decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return stripped || undefined;
}

function jsonLdProducts(html: string): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  for (const script of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(script[1]!);
      const values = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.["@graph"])
          ? ((parsed as Record<string, unknown>)["@graph"] as unknown[])
          : [parsed];
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        const record = value as Record<string, unknown>;
        if (String(record["@type"]).includes("Product")) products.push(record);
      }
    } catch {
      // A malformed block is one the adapter cannot read; the other evidence
      // on the page still counts.
    }
  }
  return products;
}

function coverageOf(fields: AdapterFields, required: readonly RequiredProductField[]) {
  const present = required.filter((field) => fields[field] !== undefined);
  return { present, missing: required.filter((field) => fields[field] === undefined) };
}

/**
 * The rows of the first table or definition list under an element carrying
 * `className`, in document order, so an evidence selector can name the row a
 * value came from.
 */
function labelledRows(
  html: string,
  className: string,
): Array<{ index: number; label: string; value: string }> {
  const table = new RegExp(`<table[^>]+class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</table>`, "i").exec(html);
  if (table) {
    const rows = [...table[1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    return rows.flatMap((row, index) => {
      const cells = [...row[1]!.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => plain(cell[1]!));
      const [label, value] = cells;
      return label && value ? [{ index: index + 1, label, value }] : [];
    });
  }
  const list = new RegExp(`<dl[^>]+class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</dl>`, "i").exec(html);
  if (!list) return [];
  return [...list[1]!.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)].flatMap((entry, index) => {
    const label = plain(entry[1]!);
    const value = plain(entry[2]!);
    return label && value ? [{ index: index + 1, label, value }] : [];
  });
}

/** The row selector for the container the rows were read from. */
function rowSelector(html: string, className: string, index: number): string {
  return new RegExp(`<table[^>]+class="[^"]*\\b${className}\\b`, "i").test(html)
    ? `table.${className} tr:nth-of-type(${index}) td`
    : `dl.${className} dt:nth-of-type(${index}) + dd`;
}

/** Coolblue: schema.org offer plus a Dutch visible specification table. */
const COOLBLUE: SourceAdapter = {
  id: "coolblue",
  version: "2026.11.1",
  hosts: ["www.coolblue.nl"],
  requiredFields: REQUIRED_PRODUCT_FIELDS,
  read(page) {
    const fields: AdapterFields = {};
    const evidence: FieldEvidence[] = [];
    const attributes: Record<string, unknown> = {};
    const jsonLdSelector = "script[type=application/ld+json]";

    for (const product of jsonLdProducts(page.html)) {
      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      const offer = offers.find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object") ?? {};
      const brand = product.brand && typeof product.brand === "object"
        ? text((product.brand as Record<string, unknown>).name)
        : text(product.brand);
      const seller = offer.seller && typeof offer.seller === "object"
        ? text((offer.seller as Record<string, unknown>).name)
        : text(offer.seller);
      const price = normalizePrice(text(offer.price));
      const currency = text(offer.priceCurrency);
      const candidates: Array<[keyof AdapterFields, string | undefined, string]> = [
        ["name", text(product.name), `${jsonLdSelector} name`],
        ["manufacturer", brand, `${jsonLdSelector} brand.name`],
        ["category", text(product.category), `${jsonLdSelector} category`],
        ["gtin", text(product.gtin13) ?? text(product.gtin), `${jsonLdSelector} gtin13`],
        ["mpn", text(product.mpn), `${jsonLdSelector} mpn`],
        ["sku", text(product.sku) ?? text(offer.sku), `${jsonLdSelector} sku`],
        ["price", price, `${jsonLdSelector} offers.price`],
        ["currency", currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined, `${jsonLdSelector} offers.priceCurrency`],
        ["seller", seller, `${jsonLdSelector} offers.seller.name`],
        [
          "condition",
          String(offer.itemCondition ?? "").toLowerCase().includes("refurbished") ? "refurbished" : "new",
          `${jsonLdSelector} offers.itemCondition`,
        ],
      ];
      for (const [field, value, selector] of candidates) {
        if (value === undefined || fields[field] !== undefined) continue;
        (fields as Record<string, unknown>)[field] = value;
        evidence.push({ field, selector, value: String(value) });
      }
      if (Object.keys(fields).length > 0) break;
    }

    // The visible table carries the Dutch specification names JSON-LD omits.
    // Values the structured data already stated are not repeated as attributes.
    const structured = new Set(Object.values(fields).map((value) => String(value)));
    for (const row of labelledRows(page.html, "spec-table")) {
      if (attributes[row.label] !== undefined || structured.has(row.value)) continue;
      attributes[row.label] = row.value;
      evidence.push({
        field: `attribute.${row.label}`,
        selector: rowSelector(page.html, "spec-table", row.index),
        value: row.value,
      });
    }

    return { fields, attributes, evidence, requiredCoverage: coverageOf(fields, this.requiredFields) };
  },
};

/** bol: no structured data; a Dutch definition list and a euro price span. */
const BOL: SourceAdapter = {
  id: "bol",
  version: "2026.11.1",
  hosts: ["www.bol.com"],
  requiredFields: REQUIRED_PRODUCT_FIELDS,
  read(page) {
    const fields: AdapterFields = {};
    const evidence: FieldEvidence[] = [];
    const attributes: Record<string, unknown> = {};

    const set = (field: keyof AdapterFields, value: string | undefined, selector: string) => {
      if (value === undefined || fields[field] !== undefined) return;
      (fields as Record<string, unknown>)[field] = value;
      evidence.push({ field, selector, value });
    };

    const title = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page.html);
    set("name", title ? plain(title[1]!) : undefined, "h1");

    // The euro sign is the adapter's assertion that this is a EUR offer; a
    // price with no recognizable currency is not recorded at all.
    const amount = /<span[^>]*class="[^"]*\bprice-amount\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(page.html);
    const rawAmount = amount ? plain(amount[1]!) : undefined;
    const price = normalizePrice(rawAmount);
    if (price !== undefined && rawAmount?.includes("€")) {
      set("price", price, "span.price-amount");
      set("currency", "EUR", "span.price-amount");
    }

    for (const row of labelledRows(page.html, "product-specs")) {
      const label = row.label.toLowerCase();
      const selector = rowSelector(page.html, "product-specs", row.index);
      if (label === "merk") set("manufacturer", row.value, selector);
      else if (label === "ean") set("gtin", /^\d{8,14}$/.test(row.value) ? row.value : undefined, selector);
      else if (label === "model") set("mpn", row.value, selector);
      else if (label === "artikelnummer") set("sku", row.value, selector);
      if (attributes[row.label] === undefined) {
        attributes[row.label] = row.value;
        evidence.push({ field: `attribute.${row.label}`, selector, value: row.value });
      }
    }

    const seller = /<p[^>]*class="[^"]*\bseller\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(page.html);
    const sellerText = seller ? plain(seller[1]!) : undefined;
    set(
      "seller",
      sellerText?.replace(/^verk(?:ocht|oper)\s+door\s+/i, "").trim(),
      "p.seller",
    );
    set("condition", "new", "body");

    return { fields, attributes, evidence, requiredCoverage: coverageOf(fields, this.requiredFields) };
  },
};

/** Every maintained adapter. Adding a retailer is a deliberate code change. */
export const MAINTAINED_ADAPTERS: readonly SourceAdapter[] = [COOLBLUE, BOL];

export function adaptersForHost(hostname: string): SourceAdapter[] {
  return MAINTAINED_ADAPTERS.filter((adapter) => adapter.hosts.includes(hostname));
}

/** The adapter that claims this URL's host, or null when the source is generic. */
export function adapterFor(url: URL): SourceAdapter | null {
  return adaptersForHost(url.hostname)[0] ?? null;
}
