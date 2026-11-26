/**
 * Reading product and offer facts out of a page.
 *
 * Four sources are read, in decreasing order of authority, because they say
 * different things and shops use different ones:
 *
 *   1. JSON-LD, which states facts explicitly and is what a shop publishes for
 *      machines;
 *   2. microdata, which states them inline and is what older shops publish;
 *   3. OpenGraph and product meta tags, which state a title, an image, and
 *      sometimes a price;
 *   4. plain markup, which is the last resort and the least certain.
 *
 * A later source only fills a gap, never overwrites, so the same page read
 * twice yields the same answer and a shop's explicit statement always beats a
 * guess from its layout. Nothing here follows a link, runs a script, or treats
 * page text as anything but data.
 */

import {
  baseHref,
  documentTitle,
  elementsNamed,
  jsonLdSources,
  metaContent,
  metaContents,
  visibleText,
  type ElementNode,
  type Node,
} from "./html.ts";
import {
  isInstalmentText,
  normaliseCurrency,
  parseMoney,
  parsePriceRange,
  unitBasisOf,
} from "./money.ts";
import type { Availability, FactSource, OfferFacts, PageFacts, ProductFacts, UnknownFact } from "./facts.ts";

/** How much page text is kept. Enough to quote, bounded so it cannot grow without limit. */
const PAGE_TEXT_LIMIT = 20_000;

type Json = unknown;

interface Builder {
  product: ProductFacts;
  offer: OfferFacts;
  title: string | undefined;
  sources: Partial<Record<keyof ProductFacts | keyof OfferFacts | "title", FactSource>>;
  jsonLdBlocks: number;
  microdataScopes: number;
  openGraphTags: number;
}

const EMPTY_PRODUCT: ProductFacts = {
  name: undefined,
  brand: undefined,
  sku: undefined,
  gtin: undefined,
  mpn: undefined,
  category: undefined,
  description: undefined,
  imageUrl: undefined,
};

const EMPTY_OFFER: OfferFacts = {
  price: undefined,
  priceRange: undefined,
  listPrice: undefined,
  unitPrice: undefined,
  unitBasis: undefined,
  currency: undefined,
  availability: undefined,
  availabilityText: undefined,
  condition: undefined,
  url: undefined,
  seller: undefined,
  priceValidUntil: undefined,
};

function setProduct<K extends keyof ProductFacts>(
  builder: Builder,
  key: K,
  value: ProductFacts[K] | undefined,
  source: FactSource,
): void {
  if (value === undefined) return;
  if (typeof value === "string" && value.trim() === "") return;
  if (builder.product[key] !== undefined) return;
  builder.product[key] = typeof value === "string" ? (value.trim() as ProductFacts[K]) : value;
  builder.sources[key] = source;
}

function setOffer<K extends keyof OfferFacts>(
  builder: Builder,
  key: K,
  value: OfferFacts[K] | undefined,
  source: FactSource,
): void {
  if (value === undefined) return;
  if (typeof value === "string" && value.trim() === "") return;
  if (builder.offer[key] !== undefined) return;
  builder.offer[key] = typeof value === "string" ? (value.trim() as OfferFacts[K]) : value;
  builder.sources[key] = source;
}

/** An absolute URL, resolved against the page, or nothing if it cannot be. */
function absoluteUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value, pageUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Schema.org's availability URLs, and the plain words shops sometimes use. */
function availabilityOf(value: string | undefined): Availability | undefined {
  if (value === undefined) return undefined;
  const text = value.toLowerCase();
  if (text.includes("outofstock") || text.includes("out of stock") || text.includes("sold out")) {
    return "out_of_stock";
  }
  if (text.includes("soldout")) return "sold_out";
  if (text.includes("preorder") || text.includes("pre-order")) return "preorder";
  if (text.includes("backorder") || text.includes("back-order")) return "backorder";
  if (text.includes("discontinued")) return "discontinued";
  if (text.includes("limited")) return "limited";
  if (text.includes("instock") || text.includes("in stock") || text.includes("available")) {
    return "in_stock";
  }
  return "unknown";
}

function conditionOf(value: string | undefined): OfferFacts["condition"] {
  if (value === undefined) return undefined;
  const text = value.toLowerCase();
  if (text.includes("new")) return "new";
  if (text.includes("used") || text.includes("secondhand") || text.includes("second hand")) {
    return "used";
  }
  if (text.includes("refurb")) return "refurbished";
  return "unknown";
}

/**
 * A JSON-LD value that may be a string, an object, or an array of either.
 * `@graph` and nested arrays are flattened, because a shop's graph is one
 * document holding its organisation, its breadcrumbs, and its product.
 */
function flattenJsonLd(value: Json, seen: Set<object> = new Set()): Record<string, Json>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => flattenJsonLd(entry, seen));
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, Json>;
  if (seen.has(record)) return [];
  seen.add(record);
  const own = [record];
  const graph = record["@graph"];
  return graph === undefined ? own : [...own, ...flattenJsonLd(graph, seen)];
}

/** The `@type` values of a node, lower-cased, whatever shape they take. */
function typesOf(node: Record<string, Json>): string[] {
  const type = node["@type"];
  const values = Array.isArray(type) ? type : [type];
  return values.flatMap((value) => (typeof value === "string" ? [value.toLowerCase()] : []));
}

/** A node's first string value among several property names. */
function stringOf(node: Record<string, Json>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = node[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim() !== "");
      if (typeof first === "string") return first.trim();
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // A property that names an entity: its name is the readable value.
      const nested = stringOf(value as Record<string, Json>, "name", "@id");
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function nodeOf(value: Json): Record<string, Json> | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const node = nodeOf(entry);
      if (node) return node;
    }
    return undefined;
  }
  return value !== null && typeof value === "object" ? (value as Record<string, Json>) : undefined;
}

function nodesOf(value: Json): Record<string, Json>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => nodesOf(entry));
  const node = nodeOf(value);
  return node ? [node] : [];
}

/** Reads one JSON-LD block into the builder. A block that is not JSON is ignored. */
function readJsonLd(builder: Builder, source: string, pageUrl: string): void {
  let parsed: Json;
  try {
    parsed = JSON.parse(source);
  } catch {
    // A malformed block is a shop's mistake, not a reason to fail the fetch:
    // the other sources may still state the facts.
    return;
  }
  builder.jsonLdBlocks += 1;
  const nodes = flattenJsonLd(parsed);
  const products = nodes.filter((node) => typesOf(node).some((type) => type.endsWith("product")));
  const offers = nodes.flatMap((node) =>
    typesOf(node).some((type) => type === "offer" || type.endsWith("offer")) ? [node] : [],
  );

  for (const product of products) {
    setProduct(builder, "name", stringOf(product, "name", "headline"), "json-ld");
    setProduct(builder, "brand", stringOf(product, "brand"), "json-ld");
    setProduct(builder, "sku", stringOf(product, "sku"), "json-ld");
    setProduct(builder, "gtin", stringOf(product, "gtin", "gtin13", "gtin12", "gtin14", "gtin8"), "json-ld");
    setProduct(builder, "mpn", stringOf(product, "mpn"), "json-ld");
    setProduct(builder, "category", stringOf(product, "category"), "json-ld");
    setProduct(builder, "description", stringOf(product, "description"), "json-ld");
    const image = product["image"];
    const imageUrl = typeof image === "string"
      ? image
      : stringOf(nodeOf(image) ?? {}, "url", "contentUrl") ?? stringOf(product, "thumbnailUrl");
    setProduct(builder, "imageUrl", absoluteUrl(imageUrl, pageUrl), "json-ld");

    // An `offers` property may hold one offer, a list of them, or an
    // AggregateOffer with a low and high price. The cheapest concrete price is
    // what a shopper compares, and a range is kept as a range.
    const offerNodes = [
      ...nodesOf(product["offers"]),
      ...offers.filter((node) => node !== product),
    ];
    for (const offer of offerNodes) {
      readJsonLdOffer(builder, offer, pageUrl);
    }
  }
  for (const offer of offers) readJsonLdOffer(builder, offer, pageUrl);
}

function readJsonLdOffer(builder: Builder, offer: Record<string, Json>, pageUrl: string): void {
  const types = typesOf(offer);
  const currency = normaliseCurrency(stringOf(offer, "priceCurrency", "currency"));
  setOffer(builder, "currency", currency, "json-ld");

  const low = stringOf(offer, "lowPrice");
  const high = stringOf(offer, "highPrice");
  if (types.some((type) => type.includes("aggregateoffer")) || (low && high)) {
    const range = parsePriceRange(`${low ?? ""} - ${high ?? ""}`, currency);
    if (range) setOffer(builder, "priceRange", range, "json-ld");
    const price = parseMoney(low, currency);
    if (price) setOffer(builder, "price", price, "json-ld");
  } else {
    const price = parseMoney(stringOf(offer, "price", "lowPrice"), currency);
    if (price) setOffer(builder, "price", price, "json-ld");
  }

  setOffer(builder, "listPrice", parseMoney(stringOf(offer, "listPrice", "strikePrice"), currency), "json-ld");
  const availabilityText = stringOf(offer, "availability", "itemCondition");
  const availability = availabilityOf(stringOf(offer, "availability"));
  setOffer(builder, "availability", availability, "json-ld");
  setOffer(builder, "availabilityText", availabilityText, "json-ld");
  setOffer(builder, "condition", conditionOf(stringOf(offer, "itemCondition")), "json-ld");
  setOffer(builder, "url", absoluteUrl(stringOf(offer, "url"), pageUrl), "json-ld");
  setOffer(builder, "seller", stringOf(offer, "seller", "offeredBy"), "json-ld");
  setOffer(builder, "priceValidUntil", stringOf(offer, "priceValidUntil"), "json-ld");
}

/** Microdata property values, gathered from an item's descendants. */
function microdataProperties(scope: ElementNode): Map<string, ElementNode[]> {
  const properties = new Map<string, ElementNode[]>();
  const walk = (node: Node, depth: number) => {
    if (node.kind === "text") return;
    const itemProp = node.attributes["itemprop"];
    if (itemProp !== undefined && depth > 0) {
      for (const name of itemProp.split(/\s+/).filter((part) => part !== "")) {
        properties.set(name, [...(properties.get(name) ?? []), node]);
      }
    }
    // A nested item scope belongs to its own item, so it is not descended
    // into: the outer item's properties stop at the inner one's boundary.
    if (node !== scope && node.attributes["itemscope"] !== undefined) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(scope, 0);
  return properties;
}

/** The value a microdata property states, by the rules of the `itemprop` spec. */
function microdataValue(element: ElementNode, pageUrl: string): string | undefined {
  const tag = element.name;
  if (tag === "meta") return element.attributes["content"];
  if (tag === "img" || tag === "audio" || tag === "video" || tag === "source") {
    const src = element.attributes["src"];
    return src === undefined ? element.attributes["content"] : absoluteUrl(src, pageUrl);
  }
  if (tag === "a" || tag === "link" || tag === "area") {
    const href = element.attributes["href"];
    return href === undefined ? undefined : absoluteUrl(href, pageUrl);
  }
  if (tag === "time" || tag === "data") {
    return element.attributes["datetime"] ?? element.attributes["value"] ?? visibleText(element);
  }
  if (tag === "object") return element.attributes["data"];
  return visibleText(element);
}

function firstMicrodata(
  properties: Map<string, ElementNode[]>,
  names: readonly string[],
  pageUrl: string,
): string | undefined {
  for (const name of names) {
    for (const element of properties.get(name) ?? []) {
      const value = microdataValue(element, pageUrl);
      if (value !== undefined && value.trim() !== "") return value.trim();
    }
  }
  return undefined;
}

function readMicrodata(builder: Builder, document: ElementNode, pageUrl: string): void {
  const scopes = collectScopes(document);
  builder.microdataScopes += scopes.length;
  for (const scope of scopes) {
    const properties = microdataProperties(scope);
    setProduct(builder, "name", firstMicrodata(properties, ["name"], pageUrl), "microdata");
    setProduct(builder, "brand", firstMicrodata(properties, ["brand"], pageUrl), "microdata");
    setProduct(builder, "sku", firstMicrodata(properties, ["sku", "productID"], pageUrl), "microdata");
    setProduct(
      builder,
      "gtin",
      firstMicrodata(properties, ["gtin", "gtin13", "gtin12", "gtin14", "gtin8"], pageUrl),
      "microdata",
    );
    setProduct(builder, "mpn", firstMicrodata(properties, ["mpn"], pageUrl), "microdata");
    setProduct(builder, "category", firstMicrodata(properties, ["category"], pageUrl), "microdata");
    setProduct(builder, "description", firstMicrodata(properties, ["description"], pageUrl), "microdata");
    setProduct(builder, "imageUrl", firstMicrodata(properties, ["image"], pageUrl), "microdata");

    const currency = normaliseCurrency(firstMicrodata(properties, ["priceCurrency"], pageUrl));
    setOffer(builder, "currency", currency, "microdata");
    const priceText = firstMicrodata(properties, ["price"], pageUrl);
    if (priceText !== undefined) {
      const range = parsePriceRange(priceText, currency);
      if (range) setOffer(builder, "priceRange", range, "microdata");
      const price = parseMoney(priceText, currency);
      if (price) setOffer(builder, "price", price, "microdata");
    }
    setOffer(
      builder,
      "listPrice",
      parseMoney(firstMicrodata(properties, ["listPrice", "strikePrice"], pageUrl), currency),
      "microdata",
    );
    const availabilityText = firstMicrodata(properties, ["availability"], pageUrl);
    setOffer(builder, "availability", availabilityOf(availabilityText), "microdata");
    setOffer(builder, "availabilityText", availabilityText, "microdata");
    setOffer(
      builder,
      "condition",
      conditionOf(firstMicrodata(properties, ["itemCondition"], pageUrl)),
      "microdata",
    );
    setOffer(builder, "url", firstMicrodata(properties, ["url"], pageUrl), "microdata");
    setOffer(builder, "seller", firstMicrodata(properties, ["seller", "offeredBy"], pageUrl), "microdata");
    setOffer(
      builder,
      "priceValidUntil",
      firstMicrodata(properties, ["priceValidUntil"], pageUrl),
      "microdata",
    );
  }
}

/** Every element carrying `itemscope`, in document order. */
function collectScopes(document: ElementNode): ElementNode[] {
  const scopes: ElementNode[] = [];
  const walk = (node: Node) => {
    if (node.kind === "text") return;
    if (node.attributes["itemscope"] !== undefined) scopes.push(node);
    for (const child of node.children) walk(child);
  };
  walk(document);
  return scopes;
}

/** OpenGraph and product meta tags: a title, an image, sometimes a price. */
function readMeta(builder: Builder, document: ElementNode, pageUrl: string): void {
  const ogTags = metaContents(document, [
    "og:title",
    "og:image",
    "og:url",
    "og:type",
    "product:price:amount",
    "product:price:currency",
    "product:availability",
    "product:brand",
    "product:retailer_item_id",
    "product:original_price:amount",
  ]);
  builder.openGraphTags += ogTags.length;

  setProduct(builder, "name", metaContent(document, ["og:title"]), "open-graph");
  setProduct(builder, "brand", metaContent(document, ["product:brand"]), "open-graph");
  setProduct(
    builder,
    "sku",
    metaContent(document, ["product:retailer_item_id"]),
    "open-graph",
  );
  setProduct(
    builder,
    "description",
    metaContent(document, ["og:description", "description"]),
    "open-graph",
  );
  setProduct(
    builder,
    "imageUrl",
    absoluteUrl(metaContent(document, ["og:image", "og:image:url", "twitter:image"]), pageUrl),
    "open-graph",
  );

  const currency = normaliseCurrency(metaContent(document, ["product:price:currency"]));
  setOffer(builder, "currency", currency, "open-graph");
  const price = parseMoney(metaContent(document, ["product:price:amount"]), currency);
  setOffer(builder, "price", price, "open-graph");
  setOffer(
    builder,
    "listPrice",
    parseMoney(metaContent(document, ["product:original_price:amount"]), currency),
    "open-graph",
  );
  const availabilityText = metaContent(document, ["product:availability"]);
  setOffer(builder, "availability", availabilityOf(availabilityText), "open-graph");
  setOffer(builder, "availabilityText", availabilityText, "open-graph");
  setOffer(
    builder,
    "url",
    absoluteUrl(metaContent(document, ["og:url"]), pageUrl) ?? pageUrl,
    "open-graph",
  );
}

/**
 * The last resort: a price read from the markup's own price elements.
 *
 * Only elements that name themselves as a price are used, and an element that
 * states an instalment, a shipping cost, or a "from" price is skipped. A price
 * guessed from arbitrary prose would be worse than no price at all.
 */
function readMarkup(builder: Builder, document: ElementNode, pageUrl: string): void {
  const currency =
    normaliseCurrency(metaContent(document, ["product:price:currency"])) ??
    builder.offer.currency;
  const priceElements = elementsNamed(document, "meta").filter((element) => {
    const key = (element.attributes["itemprop"] ?? "").toLowerCase();
    return key === "price" && element.attributes["content"] !== undefined;
  });
  for (const element of priceElements) {
    const text = element.attributes["content"] ?? "";
    const price = parseMoney(text, currency);
    if (price) setOffer(builder, "price", price, "html");
  }

  // A `<span class="price">`-style element: the class or data attribute must say
  // it is the price, so a page full of numbers cannot be read as one.
  const named = [
    ...elementsNamed(document, "span"),
    ...elementsNamed(document, "div"),
    ...elementsNamed(document, "strong"),
    ...elementsNamed(document, "p"),
  ].filter((element) => {
    const marker = `${element.attributes["class"] ?? ""} ${element.attributes["data-testid"] ?? ""} ${element.attributes["id"] ?? ""}`;
    return /(?:^|[\s_-])(?:price|sale-price|current-price|product-price)(?:$|[\s_-])/i.test(marker);
  });
  for (const element of named) {
    const text = visibleText(element);
    if (text === "" || isInstalmentText(text)) continue;
    const unitBasis = unitBasisOf(text);
    const range = parsePriceRange(text, currency);
    if (range) setOffer(builder, "priceRange", range, "html");
    const price = parseMoney(text, currency);
    if (price) setOffer(builder, "price", price, "html");
    if (unitBasis !== undefined) {
      setOffer(builder, "unitPrice", price, "html");
      setOffer(builder, "unitBasis", unitBasis, "html");
    }
  }

  setOffer(builder, "url", pageUrl, "html");
}

/**
 * Whether a page stated anything about a product at all.
 *
 * The document title and the offer's URL are deliberately not counted: every
 * page has a title and every page is its own URL, so counting either would let
 * a shop's front page pass as a product page. What counts is a fact a page
 * only states when it is selling something.
 */
export function hasProductData(builder: {
  product: ProductFacts;
  offer: OfferFacts;
}): boolean {
  const productKeys = Object.keys(EMPTY_PRODUCT) as (keyof ProductFacts)[];
  const offerKeys = (Object.keys(EMPTY_OFFER) as (keyof OfferFacts)[]).filter(
    (key) => key !== "url",
  );
  return (
    productKeys.some((key) => builder.product[key] !== undefined) ||
    offerKeys.some((key) => builder.offer[key] !== undefined)
  );
}

/**
 * Reads a parsed document into facts. The page URL is the authority for every
 * relative link, so a fact never points at a document that did not state it.
 */
export function readFacts(
  document: ElementNode,
  pageUrl: string,
  bodyText: string,
): PageFacts & { hasProductData: boolean } {
  const builder: Builder = {
    product: { ...EMPTY_PRODUCT },
    offer: { ...EMPTY_OFFER },
    title: undefined,
    sources: {},
    jsonLdBlocks: 0,
    microdataScopes: 0,
    openGraphTags: 0,
  };

  const base = baseHref(document);
  const resolvedPageUrl = absoluteUrl(base, pageUrl) ?? pageUrl;

  // JSON-LD is read from the raw script text, before anything else, because a
  // shop that publishes it has stated its facts on purpose.
  for (const source of jsonLdSources(document)) readJsonLd(builder, source, resolvedPageUrl);
  readMicrodata(builder, document, resolvedPageUrl);
  readMeta(builder, document, resolvedPageUrl);
  readMarkup(builder, document, resolvedPageUrl);

  const title = documentTitle(document);
  if (title !== undefined && title.trim() !== "") {
    builder.title = title.trim();
    builder.sources.title = "html";
  }

  // A name is the one fact every product page has; if nothing else stated it,
  // the document's own title is the shop's words for what it is selling.
  setProduct(builder, "name", builder.title, "html");
  // The offer's own URL defaults to the page fetched, which is where the price
  // was read: a caller must never have to guess where a fact came from.
  setOffer(builder, "url", resolvedPageUrl, "html");
  setOffer(builder, "currency", builder.offer.price?.currency, "html");

  const unknowns: UnknownFact[] = [];
  for (const key of Object.keys(EMPTY_PRODUCT) as (keyof ProductFacts)[]) {
    if (builder.product[key] === undefined) unknowns.push(key);
  }
  for (const key of Object.keys(EMPTY_OFFER) as (keyof OfferFacts)[]) {
    if (builder.offer[key] === undefined) unknowns.push(key);
  }

  return {
    product: builder.product,
    offer: builder.offer,
    title: builder.title,
    sources: builder.sources,
    unknowns,
    structuredData: {
      jsonLdBlocks: builder.jsonLdBlocks,
      microdataScopes: builder.microdataScopes,
      openGraphTags: builder.openGraphTags,
    },
    pageText: bodyText.slice(0, PAGE_TEXT_LIMIT),
    hasProductData: hasProductData(builder),
  };
}
