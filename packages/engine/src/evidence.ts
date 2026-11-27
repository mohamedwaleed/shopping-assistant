import type { Database } from "@shopping-assistant/database";
import type { PageExtraction, PageFacts, PriceRange, ProductFacts } from "./extraction.ts";

/**
 * The evidence store: products, exact variants, retailer offers, and the facts
 * each page stated about them.
 *
 * A source page may describe a product, one exact configuration of it, and one
 * retailer's offer, and the three must not be conflated before ranking or
 * comparison can trust them. `ingest` writes a fetched or parsed page under
 * those three concepts, matching identity conservatively; `product` reads one
 * back with its variants, offers, and evidence, so a card or a comparison sees
 * exactly what was stated and exactly what was not.
 *
 * Identity is chosen so that nothing is silently merged:
 *
 * - a product line is matched by its canonical name (and brand, when the page
 *   states one);
 * - a variant is matched by one fingerprint, chosen in this order: gtin, then
 *   sku, then mpn, then the canonical name plus the stated attributes plus the
 *   page's own URL. Two pages that share no identifier therefore always become
 *   two variants, never one;
 * - an offer is matched by its variant and its purchase URL, so re-reading a
 *   page refreshes the same offer rather than stacking a new one.
 *
 * A stated fact is recorded twice on purpose: once as a column (the current
 * structured value, null when the page did not state it) and once as a `facts`
 * row (the claim, its source URL, and its check time). Columns are what a card
 * renders; facts are the evidence a comparison can weigh.
 */

/** A fact row as read back, with its source and the time it was checked. */
export interface EvidenceFact {
  id: string;
  field: string;
  value: string;
  sourceUrl: string;
  checkTime: Date;
}

export interface EvidenceOffer {
  id: string;
  variantId: string;
  retailer: string;
  purchaseUrl: string;
  /** Null means the page did not state a price, never that the price was zero. */
  priceCents: number | null;
  currency: string | null;
  availability: string | null;
  condition: string | null;
  checkedAt: Date;
  facts: EvidenceFact[];
}

export interface EvidenceVariant {
  id: string;
  productId: string;
  fingerprint: string;
  /** The stated configuration attributes: identifiers and the available image. */
  attrs: Record<string, string>;
  offers: EvidenceOffer[];
  facts: EvidenceFact[];
}

export interface EvidenceProduct {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  createdAt: Date;
  variants: EvidenceVariant[];
  facts: EvidenceFact[];
}

/** What one ingest did: stored the page, or why it stored nothing. */
export type IngestOutcome =
  | { stored: true; productId: string }
  | { stored: false; reason: "failed" | "no_facts" };

export interface Evidence {
  /**
   * Stores an extracted page: the product line, its exact variant, the
   * retailer's offer, and a fact row for every stated fact. A page that was
   * not extracted (a failed retrieval, or one classified as anything other
   * than a product) stores nothing and leaves what was already stored
   * untouched.
   */
  ingest(extraction: PageExtraction): Promise<IngestOutcome>;
  /**
   * Reads a product back with its variants, offers, and evidence, for cards
   * and comparisons. Undefined when no such product is stored.
   */
  product(productId: string): Promise<EvidenceProduct | undefined>;
}

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  created_at: Date;
}

interface VariantRow {
  id: string;
  product_id: string;
  fingerprint: string;
  attrs: Record<string, string>;
}

interface OfferRow {
  id: string;
  variant_id: string;
  retailer: string;
  purchase_url: string;
  price_cents: number | null;
  currency: string | null;
  availability: string | null;
  condition: string | null;
  checked_at: Date;
}

interface FactRow {
  id: string;
  offer_id: string | null;
  variant_id: string | null;
  product_id: string | null;
  field: string;
  value: string;
  source_url: string;
  check_time: Date;
}

/** Anything that can build a query: the database itself or an open transaction. */
type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A name made comparable: trimmed, whitespace collapsed, lower-cased. */
function canonical(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The stated attributes of a variant: its identifiers and its available image. */
function variantAttrs(product: ProductFacts): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (product.sku !== undefined) attrs.sku = product.sku;
  if (product.gtin !== undefined) attrs.gtin = product.gtin;
  if (product.mpn !== undefined) attrs.mpn = product.mpn;
  if (product.imageUrl !== undefined) attrs.imageUrl = product.imageUrl;
  return attrs;
}

/** A JSON object in a key order that does not depend on insertion order. */
function canonicalJson(value: Record<string, string>): string {
  const pairs = Object.keys(value)
    .sort()
    .map((key) => [key, value[key] ?? ""]);
  return JSON.stringify(pairs);
}

/**
 * The identity of an exact configuration, chosen conservatively. An identifier
 * a shop publishes is the strongest claim of sameness, so the first of gtin,
 * sku, and mpn decides; with none of those, only the page itself tells one
 * ambiguous claim from another, so the page's URL joins the canonical name and
 * the stated attributes. Two pages that share no identifier can therefore
 * never collapse into one variant.
 */
function fingerprintOf(
  name: string,
  product: ProductFacts,
  attrs: Record<string, string>,
  sourceUrl: string,
): string {
  if (product.gtin !== undefined) return `gtin:${canonical(product.gtin)}`;
  if (product.sku !== undefined) return `sku:${canonical(product.sku)}`;
  if (product.mpn !== undefined) return `mpn:${canonical(product.mpn)}`;
  return `name:${canonical(name)}:attrs:${canonicalJson(attrs)}:@${sourceUrl}`;
}

/** The retailer as the page names it, or the shop the purchase URL points at. */
function retailerOf(seller: string | undefined, purchaseUrl: string): string {
  if (seller !== undefined && seller.trim() !== "") return seller.trim();
  try {
    return new URL(purchaseUrl).hostname;
  } catch {
    return purchaseUrl;
  }
}

function rangeText(range: PriceRange | undefined): string | undefined {
  return range === undefined ? undefined : `${range.low.text} – ${range.high.text}`;
}

/** `INSERT ... RETURNING` yields exactly one row or throws. */
function inserted<Row>(rows: Row[]): Row {
  const row = rows[0];
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export function createEvidence({ database }: { database: Database }): Evidence {
  async function findOrCreateProduct(
    transaction: Queryable,
    name: string,
    brand: string | undefined,
    stated: { brand: string | undefined; category: string | undefined; description: string | undefined },
  ): Promise<ProductRow> {
    const candidates = await transaction("products")
      .whereRaw(`regexp_replace(lower(btrim(name)), '\\s+', ' ', 'g') = ?`, [canonical(name)])
      .orderBy("created_at", "asc")
      .select<ProductRow[]>(["id", "name", "brand", "category", "description", "created_at"]);
    if (candidates.length > 0) {
      if (brand === undefined) return inserted(candidates);
      const brandMatch = candidates.find(
        (row) => row.brand !== null && canonical(row.brand) === canonical(brand),
      );
      if (brandMatch !== undefined) return brandMatch;
    }
    const rows = await transaction("products")
      .insert({
        name,
        ...(stated.brand === undefined ? {} : { brand: stated.brand }),
        ...(stated.category === undefined ? {} : { category: stated.category }),
        ...(stated.description === undefined ? {} : { description: stated.description }),
      })
      .returning<ProductRow[]>(["id", "name", "brand", "category", "description", "created_at"]);
    return inserted(rows);
  }

  async function findOrCreateVariant(
    transaction: Queryable,
    productId: string,
    fingerprint: string,
    attrs: Record<string, string>,
  ): Promise<VariantRow> {
    const existing = await transaction("variants")
      .where({ product_id: productId, fingerprint })
      .first<VariantRow>(["id", "product_id", "fingerprint", "attrs"]);
    if (existing !== undefined) return existing;
    const rows = await transaction("variants")
      .insert({ product_id: productId, fingerprint, attrs })
      .returning<VariantRow[]>(["id", "product_id", "fingerprint", "attrs"]);
    return inserted(rows);
  }

  async function findOrRefreshOffer(
    transaction: Queryable,
    variantId: string,
    purchaseUrl: string,
    checked: {
      retailer: string;
      priceCents: number | null;
      currency: string | null;
      availability: string | null;
      condition: string | null;
      checkedAt: Date;
    },
  ): Promise<OfferRow> {
    const columns = [
      "id",
      "variant_id",
      "retailer",
      "purchase_url",
      "price_cents",
      "currency",
      "availability",
      "condition",
      "checked_at",
    ] as const;
    const existing = await transaction("offers")
      .where({ variant_id: variantId, purchase_url: purchaseUrl })
      .first<OfferRow>([...columns]);
    if (existing !== undefined) {
      // Re-reading the same page refreshes the offer's checked values: what
      // this check found stands, and what it did not find is missing again.
      const rows = await transaction("offers")
        .where({ id: existing.id })
        .update({
          price_cents: checked.priceCents,
          currency: checked.currency,
          availability: checked.availability,
          condition: checked.condition,
          checked_at: checked.checkedAt,
        })
        .returning<OfferRow[]>([...columns]);
      return inserted(rows);
    }
    const rows = await transaction("offers")
      .insert({
        variant_id: variantId,
        retailer: checked.retailer,
        purchase_url: purchaseUrl,
        price_cents: checked.priceCents,
        currency: checked.currency,
        availability: checked.availability,
        condition: checked.condition,
        checked_at: checked.checkedAt,
      })
      .returning<OfferRow[]>([...columns]);
    return inserted(rows);
  }

  async function recordFacts(
    transaction: Queryable,
    scoped: {
      productId: string;
      variantId: string;
      offerId: string;
      facts: PageFacts;
      sourceUrl: string;
      checkedAt: Date;
    },
  ): Promise<void> {
    const rows: {
      field: string;
      value: string;
      source_url: string;
      check_time: Date;
      offer_id?: string;
      variant_id?: string;
      product_id?: string;
    }[] = [];

    const productFields: [string, string | undefined][] = [
      ["name", scoped.facts.product.name],
      ["brand", scoped.facts.product.brand],
      ["category", scoped.facts.product.category],
      ["description", scoped.facts.product.description],
    ];
    for (const [field, value] of productFields) {
      if (value === undefined) continue;
      rows.push({
        field,
        value,
        source_url: scoped.sourceUrl,
        check_time: scoped.checkedAt,
        product_id: scoped.productId,
      });
    }

    const variantFields: [string, string | undefined][] = [
      ["sku", scoped.facts.product.sku],
      ["gtin", scoped.facts.product.gtin],
      ["mpn", scoped.facts.product.mpn],
      ["imageUrl", scoped.facts.product.imageUrl],
    ];
    for (const [field, value] of variantFields) {
      if (value === undefined) continue;
      rows.push({
        field,
        value,
        source_url: scoped.sourceUrl,
        check_time: scoped.checkedAt,
        variant_id: scoped.variantId,
      });
    }

    const offerFields: [string, string | undefined][] = [
      ["price", scoped.facts.offer.price?.text],
      ["priceRange", rangeText(scoped.facts.offer.priceRange)],
      ["listPrice", scoped.facts.offer.listPrice?.text],
      ["unitPrice", scoped.facts.offer.unitPrice?.text],
      ["unitBasis", scoped.facts.offer.unitBasis],
      ["currency", scoped.facts.offer.currency],
      ["availability", scoped.facts.offer.availability],
      ["availabilityText", scoped.facts.offer.availabilityText],
      ["condition", scoped.facts.offer.condition],
      ["url", scoped.facts.offer.url],
      ["seller", scoped.facts.offer.seller],
      ["priceValidUntil", scoped.facts.offer.priceValidUntil],
    ];
    for (const [field, value] of offerFields) {
      if (value === undefined) continue;
      rows.push({
        field,
        value,
        source_url: scoped.sourceUrl,
        check_time: scoped.checkedAt,
        offer_id: scoped.offerId,
      });
    }

    if (rows.length === 0) return;
    await transaction("facts").insert(rows);
  }

  return {
    async ingest(extraction: PageExtraction): Promise<IngestOutcome> {
      if (!extraction.ok) return { stored: false, reason: "failed" };
      if (extraction.facts === undefined) return { stored: false, reason: "no_facts" };
      const { facts } = extraction;
      const sourceUrl = extraction.sourceUrl;
      const checkedAt = extraction.checkedAt;

      return database.transaction(async (transaction) => {
        const name = facts.product.name ?? facts.title ?? "Unnamed product";
        const product = await findOrCreateProduct(transaction, name, facts.product.brand, {
          brand: facts.product.brand,
          category: facts.product.category,
          description: facts.product.description,
        });

        const attrs = variantAttrs(facts.product);
        const fingerprint = fingerprintOf(name, facts.product, attrs, sourceUrl);
        const variant = await findOrCreateVariant(transaction, product.id, fingerprint, attrs);

        const purchaseUrl = facts.offer.url ?? sourceUrl;
        const offer = await findOrRefreshOffer(transaction, variant.id, purchaseUrl, {
          retailer: retailerOf(facts.offer.seller, purchaseUrl),
          priceCents: facts.offer.price?.amountMinor ?? null,
          currency: facts.offer.currency ?? null,
          availability: facts.offer.availability ?? null,
          condition: facts.offer.condition ?? null,
          checkedAt,
        });

        await recordFacts(transaction, {
          productId: product.id,
          variantId: variant.id,
          offerId: offer.id,
          facts,
          sourceUrl,
          checkedAt,
        });

        return { stored: true, productId: product.id };
      });
    },

    async product(productId: string): Promise<EvidenceProduct | undefined> {
      const productRow = await database("products")
        .where({ id: productId })
        .first<ProductRow>(["id", "name", "brand", "category", "description", "created_at"]);
      if (productRow === undefined) return undefined;

      const variantRows = await database("variants")
        .where({ product_id: productId })
        .orderBy("fingerprint")
        .select<VariantRow[]>(["id", "product_id", "fingerprint", "attrs"]);
      const variantIds = variantRows.map((row) => row.id);

      const offerRows =
        variantIds.length === 0
          ? []
          : await database("offers")
              .whereIn("variant_id", variantIds)
              .orderBy("checked_at", "desc")
              .select<OfferRow[]>([
                "id",
                "variant_id",
                "retailer",
                "purchase_url",
                "price_cents",
                "currency",
                "availability",
                "condition",
                "checked_at",
              ]);
      const offerIds = offerRows.map((row) => row.id);

      let factsQuery = database("facts").where("product_id", productId);
      if (variantIds.length > 0) factsQuery = factsQuery.orWhereIn("variant_id", variantIds);
      if (offerIds.length > 0) factsQuery = factsQuery.orWhereIn("offer_id", offerIds);
      const factRows = await factsQuery
        .orderBy("check_time", "desc")
        .select<FactRow[]>([
          "id",
          "offer_id",
          "variant_id",
          "product_id",
          "field",
          "value",
          "source_url",
          "check_time",
        ]);

      const toFact = (row: FactRow): EvidenceFact => ({
        id: row.id,
        field: row.field,
        value: row.value,
        sourceUrl: row.source_url,
        checkTime: row.check_time,
      });

      const productFacts = factRows
        .filter((row) => row.product_id === productId)
        .map(toFact);

      const variants: EvidenceVariant[] = variantRows.map((variantRow) => {
        const offers = offerRows
          .filter((row) => row.variant_id === variantRow.id)
          .map((row) => ({
            id: row.id,
            variantId: row.variant_id,
            retailer: row.retailer,
            purchaseUrl: row.purchase_url,
            priceCents: row.price_cents,
            currency: row.currency,
            availability: row.availability,
            condition: row.condition,
            checkedAt: row.checked_at,
            facts: factRows.filter((fact) => fact.offer_id === row.id).map(toFact),
          }));
        return {
          id: variantRow.id,
          productId: variantRow.product_id,
          fingerprint: variantRow.fingerprint,
          attrs: variantRow.attrs,
          offers,
          facts: factRows.filter((fact) => fact.variant_id === variantRow.id).map(toFact),
        };
      });

      return {
        id: productRow.id,
        name: productRow.name,
        brand: productRow.brand,
        category: productRow.category,
        description: productRow.description,
        createdAt: productRow.created_at,
        variants,
        facts: productFacts,
      };
    },
  };
}