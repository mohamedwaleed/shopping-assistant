import { documentTitle, metaContents, type ElementNode } from "./html.ts";

/**
 * What a retrieval turned out to be.
 *
 * Only `"extracted"` carries evidence. Every other outcome is a page that
 * exists but cannot be read as a retailer's statement about a product, and a
 * shopper comparing offers must be told which of them happened: "the shop
 * refused us" and "we could not make sense of the page" lead to different next
 * steps, and neither is a price.
 */
export type PageClassification =
  | "extracted"
  | "unavailable"
  | "blocked"
  | "challenge"
  | "unsupported"
  | "unusable";

/** Why a page was not usable as evidence, in a form a shopper can be shown. */
export type PageReason =
  | "not_found"
  | "server_error"
  | "access_denied"
  | "rate_limited"
  | "robots_disallowed"
  | "interstitial"
  | "captcha"
  | "not_html"
  | "html_unparseable"
  | "no_product_data";

export interface Classification {
  classification: PageClassification;
  reason?: PageReason;
  /** What the page said it was, when that is what ruled it out. */
  mediaType?: string;
}

/**
 * Markers of a bot-check or consent interstitial. These are matched against the
 * page's own visible text and metadata only to decide whether the page is a
 * challenge; nothing matched here is ever acted on, and no attempt is made to
 * satisfy the challenge. A page that asks a shopper to prove they are human is
 * a page we leave alone.
 */
const CHALLENGE_MARKERS: readonly string[] = [
  "captcha",
  "recaptcha",
  "hcaptcha",
  "cf-challenge",
  "challenge-platform",
  "just a moment...",
  "checking your browser",
  "verifying you are human",
  "verify you are human",
  "enable javascript and cookies to continue",
  "are you a robot",
  "unusual traffic",
  "access to this page has been denied",
  "press and hold",
  "attention required! | cloudflare",
  "px-captcha",
  "perimeterx",
  "datadome",
  "incapsula incident",
  "request unsuccessful. incapsula",
];

/** Text that means the shop refused this client outright. */
const BLOCKED_MARKERS: readonly string[] = [
  "access denied",
  "403 forbidden",
  "request blocked",
  "you have been blocked",
  "forbidden - you don't have permission",
  "sign in to continue",
  "log in to continue",
  "subscribe to continue",
  "subscribe to read",
  "this content is for subscribers",
  "create an account to view",
];

/** Text that means the page exists but states nothing about a product. */
const UNUSABLE_MARKERS: readonly string[] = [
  "page not found",
  "we can't find that page",
  "no longer available",
  "this item is no longer",
  "product has been discontinued",
];

/** What a page's status code says, before its body is looked at. */
export function classifyStatus(status: number): Classification | undefined {
  if (status === 401 || status === 403) {
    return { classification: "blocked", reason: "access_denied" };
  }
  if (status === 429) return { classification: "blocked", reason: "rate_limited" };
  if (status === 404 || status === 410) {
    return { classification: "unavailable", reason: "not_found" };
  }
  if (status >= 500) return { classification: "unavailable", reason: "server_error" };
  if (status >= 400) return { classification: "blocked", reason: "access_denied" };
  return undefined;
}

/** Whether a media type is HTML a parser can read. */
export function isHtmlMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) return false;
  const essence = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "text/html" || essence === "application/xhtml+xml";
}

/**
 * The page's own words, gathered for marker matching only. It is never
 * returned to a caller: what a page says here is a classification signal, and
 * the caller's evidence comes from the extractors.
 */
function haystack(document: ElementNode, bodyText: string): string {
  return [
    documentTitle(document) ?? "",
    ...metaContents(document, ["robots", "description", "og:title"]),
    bodyText,
  ]
    .join(" ")
    .toLowerCase();
}

function mentionsAny(haystackText: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystackText.includes(marker));
}

export interface ClassifyOptions {
  status: number;
  mediaType: string | undefined;
  /** Whether the parsed document holds any structured product data at all. */
  hasProductData: boolean;
  document: ElementNode;
  /** The page's readable text, from `visibleText`. */
  bodyText: string;
}

/**
 * Classifies a fetched page. Status codes decide first, because a shop that
 * answered 403 or 404 said what it meant; only a 2xx page is examined for the
 * interstitials and dead ends that arrive with a 200.
 */
export function classifyPage({
  status,
  mediaType,
  hasProductData,
  document,
  bodyText,
}: ClassifyOptions): Classification {
  const byStatus = classifyStatus(status);
  if (byStatus) return byStatus;

  if (!isHtmlMediaType(mediaType)) {
    return {
      classification: "unsupported",
      reason: "not_html",
      ...(mediaType === undefined ? {} : { mediaType }),
    };
  }

  const text = haystack(document, bodyText);
  const robots = metaContents(document, ["robots"]).join(" ").toLowerCase();
  if (robots.includes("noindex") && mentionsAny(text, BLOCKED_MARKERS)) {
    return { classification: "blocked", reason: "robots_disallowed" };
  }

  // A challenge is checked before anything else about the body: an
  // interstitial often carries a shop's title and branding, and mistaking one
  // for a product page is how a "price" ends up being invented.
  if (mentionsAny(text, CHALLENGE_MARKERS)) {
    return { classification: "challenge", reason: "captcha" };
  }

  if (mentionsAny(text, BLOCKED_MARKERS)) {
    return { classification: "blocked", reason: "interstitial" };
  }

  if (bodyText.trim() === "") {
    return { classification: "unusable", reason: "html_unparseable" };
  }

  if (mentionsAny(text, UNUSABLE_MARKERS)) {
    return { classification: "unusable", reason: "not_found" };
  }

  if (!hasProductData) return { classification: "unusable", reason: "no_product_data" };

  return { classification: "extracted" };
}
