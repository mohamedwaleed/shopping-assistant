import {
  DEFAULT_FETCH_BOUNDS,
  fetchPage,
  isHtml,
  pageText,
  type AddressResolver,
  type FetchBounds,
  type FetchFailure,
} from "./extraction/fetch.ts";
import { judgeUrl } from "./extraction/destination.ts";
import { parseHtml, visibleText, type ElementNode } from "./extraction/html.ts";
import { readFacts } from "./extraction/extract.ts";
import { classifyPage, classifyStatus, type PageClassification, type PageReason } from "./extraction/classify.ts";
import type { PageFacts } from "./extraction/facts.ts";
import {
  ResearchAllowanceExhaustedError,
  type Research,
  type UsageReservationRecord,
} from "./research.ts";

/**
 * Reading an accessible product page.
 *
 * This is the first of the extraction options: the installation fetches a page
 * itself, parses what the page states, and hands back the facts it found with
 * the page they came from. It uses no search index and no model, and it
 * bypasses nothing: a login wall, a paywall, and a CAPTCHA are all reported as
 * outcomes rather than worked around.
 *
 * Two rules run through the whole file.
 *
 * 1. Page content is DATA. It is quoted, classified, and parsed into fields; it
 *    is never interpreted as an instruction and never decides what happens
 *    next. The only thing a response can steer is the `Location` of a redirect,
 *    and that is a URL judged by the same rules as the one requested.
 * 2. Every attempt is charged. Each fetch, retries included, reserves against
 *    the research run before it is made and settles afterwards, so the ledger
 *    — not this module's goodwill — is what bounds spending.
 */

export type { PageClassification, PageReason } from "./extraction/classify.ts";
export { DEFAULT_FETCH_BOUNDS } from "./extraction/fetch.ts";
export type { AddressResolver, FetchBounds, FetchFailure } from "./extraction/fetch.ts";
export type {
  Availability,
  OfferFacts,
  PageFacts,
  ProductFacts,
  UnknownFact,
} from "./extraction/facts.ts";
export type { Money, PriceRange } from "./extraction/money.ts";

/**
 * What the deployment allows page extraction to be configured with. A ceiling
 * only ever narrows, and `permittedPorts` is the one bound where narrowing is
 * the whole point: a port list is intersected rather than taken, so a ceiling
 * can take a port away and never add one.
 */
export type ExtractionCeilings = Partial<FetchBounds>;

/** The outcome of asking for one page, whether or not a page was read. */
export type PageExtraction = PageExtractionSuccess | PageExtractionFailure;

interface PageExtractionCommon {
  /** The URL asked for, exactly as supplied. */
  requestedUrl: string;
  /** When the page was checked, from the engine's clock. */
  checkedAt: Date;
  /** How many retrieval calls the ledger was charged for, retries included. */
  fetches: number;
  /** Total time spent retrieving, which is also what the ledger settled to. */
  durationMs: number;
}

/**
 * A page that was fetched. `facts` is present only when the page is
 * `extracted`: every other classification carries `facts: undefined`, because
 * a blocked or unusable page has no evidence to offer and a caller must not be
 * able to read one by accident.
 */
export interface PageExtractionSuccess extends PageExtractionCommon {
  ok: true;
  classification: PageClassification;
  /** Why it was not usable; absent only for an extracted page. */
  reason?: PageReason;
  /** Where the body actually came from, after every redirect. */
  sourceUrl: string;
  /** Every URL the retrieval passed through, so a redirect chain is auditable. */
  redirectChain: string[];
  /** The page's facts, when the page was usable. */
  facts: PageFacts | undefined;
}

/**
 * A retrieval that produced nothing to classify. `refused` and `failed` are
 * kept apart: the first is a request this installation declined to make, the
 * second one it could not complete.
 */
export interface PageExtractionFailure extends PageExtractionCommon {
  ok: false;
  outcome: "refused" | "failed";
  failure: FetchFailure;
  /** True when the research run had no allowance left for even one fetch. */
  allowanceReached: boolean;
}

/** Raised when the caller asks for something the bounds forbid outright. */
export class ExtractionRefusedError extends Error {
  constructor(reason: string) {
    super(`Page extraction refused: ${reason}`);
    this.name = "ExtractionRefusedError";
  }
}

export interface Extraction {
  /** The bounds in force, after the operator's ceiling. */
  bounds(): FetchBounds;
  /**
   * Fetches and parses one page for a research run the caller owns, charging
   * the run for the retrieval. Refused — as an outcome, with
   * `allowanceReached` set — when the run has no allowance for even one fetch:
   * a run that cannot pay must not make the call.
   */
  fetchPage(
    userId: string,
    runId: string,
    url: string,
    options?: { attempt?: number },
  ): Promise<PageExtraction>;
  /**
   * Parses HTML the caller already holds — a cached page, a fixture — without
   * charging anything, because no network call is made. It is the same parser
   * the fetch path uses, so a page read twice reads the same.
   */
  parse(input: { url: string; html: string; status?: number; mediaType?: string }): PageExtraction;
}

/** The tighter of two bounds: a ceiling restricts, so it never widens one. */
function narrowed(bounds: FetchBounds, ceilings: ExtractionCeilings): FetchBounds {
  return {
    timeoutMs: Math.min(bounds.timeoutMs, ceilings.timeoutMs ?? bounds.timeoutMs),
    maxRedirects: Math.min(bounds.maxRedirects, ceilings.maxRedirects ?? bounds.maxRedirects),
    maxResponseBytes: Math.min(
      bounds.maxResponseBytes,
      ceilings.maxResponseBytes ?? bounds.maxResponseBytes,
    ),
    permittedPorts: (ceilings.permittedPorts ?? bounds.permittedPorts).filter((port) =>
      bounds.permittedPorts.includes(port),
    ),
  };
}

/**
 * Reads a page into facts and a classification. Pure: it touches no network
 * and no database, so a fixture and a live response take the same path and a
 * parsing bug cannot hide behind a fetch.
 */
function read(
  url: string,
  html: string,
  status: number,
  mediaType: string | undefined,
): {
  facts: ReturnType<typeof readFacts>;
  classification: ReturnType<typeof classifyPage>;
} {
  const document: ElementNode = parseHtml(html);
  // The text is computed once, so the classifier and the extractor look at
  // exactly the same string.
  const bodyText = visibleText(document);
  const facts = readFacts(document, url, bodyText);
  const byStatus = classifyStatus(status);
  const classification =
    byStatus ??
    classifyPage({
      status,
      mediaType,
      hasProductData: facts.hasProductData,
      document,
      bodyText,
    });
  return { facts, classification };
}

export function createExtraction({
  research,
  ceilings = {},
  costPerFetchCents,
  now = () => new Date(),
  resolve,
  permittedAddresses = [],
  permittedPorts,
}: {
  research: Research;
  /** What the operator allows retrieval to be configured with. */
  ceilings?: ExtractionCeilings;
  /** Cents one retrieval is estimated to cost; absent means its price is unknown. */
  costPerFetchCents?: number;
  now?: () => Date;
  /** How names are resolved; the system resolver unless a caller supplies one. */
  resolve?: AddressResolver;
  /**
   * Addresses judged safe despite being private. A deployment leaves this
   * empty: it exists so the test suite can point a public-looking name at the
   * server it controls, and is deliberately not reachable from configuration.
   */
  permittedAddresses?: readonly string[];
  /**
   * Ports a URL may name. A deployment leaves this empty and the default web
   * ports stand; the test suite needs its own, because a test server listens
   * on an ephemeral port.
   */
  permittedPorts?: readonly number[];
}): Extraction {
  const bounds = narrowed(
    permittedPorts === undefined
      ? DEFAULT_FETCH_BOUNDS
      : { ...DEFAULT_FETCH_BOUNDS, permittedPorts },
    ceilings,
  );
  const pricing =
    costPerFetchCents !== undefined &&
    Number.isFinite(costPerFetchCents) &&
    costPerFetchCents >= 0
      ? { unitCents: costPerFetchCents, units: 1 }
      : {};

  function outcomeOf(
    requestedUrl: string,
    classification: ReturnType<typeof classifyPage>,
    facts: ReturnType<typeof readFacts> | undefined,
    sourceUrl: string,
    redirectChain: string[],
    checkedAt: Date,
    durationMs: number,
    fetches: number,
  ): PageExtraction {
    // Evidence exists only for a page that was read as a product page. Every
    // other outcome states why, and states nothing else.
    const usable = classification.classification === "extracted" && facts !== undefined;
    return {
      ok: true,
      classification: classification.classification,
      ...(classification.reason === undefined ? {} : { reason: classification.reason }),
      requestedUrl,
      sourceUrl,
      redirectChain,
      checkedAt,
      fetches,
      durationMs,
      facts: usable ? facts : undefined,
    };
  }

  return {
    bounds: () => ({ ...bounds }),

    parse({ url, html, status = 200, mediaType = "text/html" }) {
      const { facts, classification } = read(url, html, status, mediaType);
      return outcomeOf(url, classification, facts, url, [url], now(), 0, 0);
    },

    async fetchPage(userId, runId, url, { attempt = 1 } = {}) {
      // An attempt below one would understate the calls made, and the ledger
      // counts calls as well as money.
      if (!Number.isInteger(attempt) || attempt < 1) {
        throw new ExtractionRefusedError("an attempt is a whole number, one or more");
      }
      const startedAt = Date.now();
      const checkedAt = now();

      // A URL the rules refuse outright — a scheme, a host, a port — is judged
      // before the ledger is touched. Nothing is requested for it, so charging
      // it would tell a shopper a call was made that never was, and would spend
      // a run's allowance on an address the installation declined to reach.
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        return {
          ok: false,
          outcome: "failed",
          failure: { kind: "invalid_url" },
          allowanceReached: false,
          requestedUrl: url,
          checkedAt,
          fetches: 0,
          durationMs: Date.now() - startedAt,
        };
      }
      const refused = judgeUrl(parsed, bounds.permittedPorts);
      if (refused) {
        return {
          ok: false,
          outcome: "refused",
          failure: { kind: "refused", refusal: refused },
          allowanceReached: false,
          requestedUrl: url,
          checkedAt,
          fetches: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      let reservation: UsageReservationRecord;
      try {
        reservation = await research.reserve(userId, runId, {
          // A retry is its own kind in the ledger, so an operator can see how
          // much of a run's allowance went on pages that failed the first time.
          callKind: attempt === 1 ? "retrieval" : "retry",
          pricing,
          estimatedDurationMs: bounds.timeoutMs,
        });
      } catch (error) {
        // The allowance is the one refusal that is an outcome rather than a
        // fault: the ledger has already paused the run, and the caller is told
        // that no fetch was made rather than that the page failed. Anything
        // else — a paused or stopped run, an unknown run — is a fault the
        // caller must see, so it is re-thrown unchanged.
        if (!(error instanceof ResearchAllowanceExhaustedError)) throw error;
        return {
          ok: false,
          outcome: "failed",
          failure: { kind: "failed", detail: "research allowance reached" },
          allowanceReached: true,
          requestedUrl: url,
          checkedAt,
          fetches: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      let outcome;
      try {
        outcome = await fetchPage(url, {
          bounds,
          ...(resolve === undefined ? {} : { resolve }),
          permittedAddresses,
        });
      } catch (error) {
        // A fetch that threw rather than reported is a fault in this process,
        // not a statement about the shop: the reservation is given back so the
        // shopper is not charged for a call that produced nothing at all.
        await research.release(userId, reservation.id);
        throw error;
      }

      // Every attempt is settled, whatever it found: the network call happened
      // and the ledger's call count must say so. A blocked page costs what a
      // page that was read costs, which is what stops a run from trying a
      // thousand blocked pages for free. The settlement states the price the
      // reservation was made at, because a priced call that settles without one
      // would be recorded as unknown and make the run's totals incomplete.
      await research.settle(userId, {
        reservationId: reservation.id,
        ...(reservation.priced ? { actualCents: reservation.reservedCents } : {}),
        durationMs: Date.now() - startedAt,
      });

      if (!outcome.ok) {
        return {
          ok: false,
          outcome: outcome.failure.kind === "refused" ? "refused" : "failed",
          failure: outcome.failure,
          allowanceReached: false,
          requestedUrl: url,
          checkedAt,
          fetches: 1,
          durationMs: outcome.durationMs,
        };
      }

      const { page } = outcome;
      if (!isHtml(page.mediaType)) {
        // Nothing was read from a body that is not HTML, so there is no text
        // to classify: the media type itself is the answer.
        return outcomeOf(
          url,
          classifyPage({
            status: page.status,
            mediaType: page.mediaType,
            hasProductData: false,
            document: parseHtml(""),
            bodyText: "",
          }),
          undefined,
          page.url,
          page.chain,
          checkedAt,
          page.durationMs,
          1,
        );
      }

      const { facts, classification } = read(page.url, pageText(page), page.status, page.mediaType);
      return outcomeOf(
        url,
        classification,
        facts,
        page.url,
        page.chain,
        checkedAt,
        page.durationMs,
        1,
      );
    },
  };
}
