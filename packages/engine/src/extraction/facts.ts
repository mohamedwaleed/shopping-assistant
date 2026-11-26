/**
 * The facts a page can yield, and the record of what it did not say.
 *
 * Product pages across shops agree on very little: one publishes JSON-LD, the
 * next only OpenGraph tags, the next only microdata, and a price is sometimes a
 * property and sometimes a sentence. Nothing here assumes one schema. A fact is
 * filled in from whichever source states it, the source is kept with the value,
 * and anything no source stated stays `undefined` and is named in `unknowns` so
 * that an absent fact can never be read as a stated one.
 */

import type { Money, PriceRange } from "./money.ts";

/** Where a fact came from, so a shopper can weigh two shops against each other. */
export type FactSource = "json-ld" | "open-graph" | "microdata" | "html";

export type Availability =
  | "in_stock"
  | "out_of_stock"
  | "preorder"
  | "backorder"
  | "discontinued"
  | "limited"
  | "sold_out"
  | "unknown";

export interface ProductFacts {
  name: string | undefined;
  brand: string | undefined;
  /** The manufacturer's or shop's own identifier, not our key for the product. */
  sku: string | undefined;
  gtin: string | undefined;
  mpn: string | undefined;
  /** What kind of thing it is, in the page's own words ("Bicycle helmet"). */
  category: string | undefined;
  description: string | undefined;
  /** Absolute, resolved against the page, so a relative href is not ambiguous. */
  imageUrl: string | undefined;
}

export interface OfferFacts {
  price: Money | undefined;
  /** Stated when the page quotes a range rather than one price. */
  priceRange: PriceRange | undefined;
  /** The struck-through price, when the page states one. */
  listPrice: Money | undefined;
  /** The price per unit of measure, as groceries state it. */
  unitPrice: Money | undefined;
  /** What the unit price is per, e.g. "kg". */
  unitBasis: string | undefined;
  currency: string | undefined;
  availability: Availability | undefined;
  /** The shop's own words for availability, kept because the mapping loses detail. */
  availabilityText: string | undefined;
  condition: "new" | "used" | "refurbished" | "unknown" | undefined;
  /** Where the offer may be bought, absolute. */
  url: string | undefined;
  seller: string | undefined;
  /** When the page says the price stops being valid. */
  priceValidUntil: string | undefined;
}

/** A named fact the page did not state, so a caller never mistakes it for zero. */
export type UnknownFact = keyof ProductFacts | keyof OfferFacts;

export interface PageFacts {
  product: ProductFacts;
  offer: OfferFacts;
  /** The page's title, as the shop wrote it. */
  title: string | undefined;
  /** Where each fact came from, for the facts that were found. */
  sources: Partial<Record<keyof ProductFacts | keyof OfferFacts | "title", FactSource>>;
  /** Every fact no source stated, in a stable order. */
  unknowns: UnknownFact[];
  /** How many structured blocks of each kind the page carried, for diagnosis. */
  structuredData: { jsonLdBlocks: number; microdataScopes: number; openGraphTags: number };
  /**
   * The page's own text, bounded, kept as DATA.
   *
   * This string is what the page said. It is not an instruction to this
   * installation, not a source of control flow, and not an authority: a page
   * that writes "ignore previous instructions" has been quoted, nothing more.
   * It is deliberately not consulted by any decision this engine makes.
   */
  pageText: string;
}
