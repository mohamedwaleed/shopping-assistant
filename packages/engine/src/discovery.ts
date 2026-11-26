import { createHash } from "node:crypto";
import type { Requirements, Requirement } from "./index.ts";
import {
  ResearchAllowanceExhaustedError,
  ResearchRunStateError,
  type Research,
  type ResearchRun,
} from "./research.ts";

/**
 * Discovery finds candidate product pages. It is the first half of research,
 * and deliberately the weaker half: a search result says a page exists and what
 * a search engine claims about it, not that the page sells what the shopper
 * asked for, at what price, or to the Netherlands. Everything here is therefore
 * a *candidate* and a *claim*, and only fetching and parsing a page (a later
 * ticket) can turn either into a fact.
 *
 * SearXNG is the default provider because it needs no paid credentials: an
 * operator points the installation at an instance and discovery works.
 */

/** The languages a query is written in: the shopper's market and English. */
export type DiscoveryLanguage = "nl" | "en";

/**
 * One search the shopper's requirements were turned into. It carries only the
 * query text and the shape of that text: no account detail, no email, and no
 * conversation history beyond the requirements themselves.
 */
export interface DiscoveryQuery {
  /**
   * Derived from what the query asks, never from who asked it, and laid out as
   * a uuid because that is the ledger's reference column. It is what the usage
   * ledger records, which keeps the shopper's own words out of the accounting,
   * and two runs asking the same thing send the same reference.
   */
  reference: string;
  /** The query string exactly as it is sent, so a test can inspect the payload. */
  text: string;
  language: DiscoveryLanguage;
  /** The requirement statements the query was built from, for the shopper to see. */
  from: string[];
}

/**
 * Where a candidate came from, so anything shown to a shopper can say which
 * search produced it and in which language.
 */
export interface DiscoveryProvenance {
  provider: "searxng";
  query: {
    reference: string;
    text: string;
    language: DiscoveryLanguage;
  };
  /** The position the provider ranked this result at, from one. */
  rank: number;
}

/**
 * A page that may be worth fetching. Nothing on it has been verified.
 *
 * `title` and `snippet` are the search engine's words, not the shop's, and not
 * this application's. They are `unverifiedClaim` in the type itself so that no
 * code path can read a snippet as a suitability, price, or delivery fact: a
 * consumer that wants a fact has to fetch the page.
 */
export interface DiscoveredCandidate {
  /** The page, normalised, and unique within one discovery. */
  url: string;
  /** The host the page is served from, for grouping results by shop. */
  domain: string;
  /** The provider's headline for the page, unverified. */
  title: UnverifiedClaim;
  /** The provider's excerpt, unverified. Absent when the provider gave none. */
  snippet?: UnverifiedClaim;
  provenance: DiscoveryProvenance;
}

/**
 * A string a search engine supplied. The wrapper is the point: a claim cannot
 * be compared, displayed as a price, or passed where a fact is expected without
 * naming the field, which is where a reviewer will look for the missing fetch.
 */
export interface UnverifiedClaim {
  readonly evidence: "unverified_claim";
  readonly text: string;
}

/** Turns provider text into a claim, trimming it and dropping an empty one. */
export function unverifiedClaim(text: string): UnverifiedClaim | undefined {
  const trimmed = text.trim();
  return trimmed.length === 0 ? undefined : { evidence: "unverified_claim", text: trimmed };
}

/**
 * Why discovery produced what it did. Every outcome other than `ok` names a
 * cause, so a caller can tell "the provider is not configured" and "the
 * provider did not answer" from "there is genuinely nothing out there", which
 * are three different things to say to a shopper.
 */
export type DiscoveryOutcome =
  | "ok"
  | "no_results"
  /** The provider answered, but nothing it returned was a usable candidate. */
  | "inadequate"
  | "unconfigured"
  | "unavailable"
  | "malformed";

export interface DiscoveryAttempt {
  query: DiscoveryQuery;
  /** What came back for this one search. */
  outcome: Exclude<DiscoveryOutcome, "unconfigured">;
  /** Candidates this search contributed, before duplicates across queries. */
  found: number;
  /** Calls the provider charged for, which is one unless the search was never sent. */
  calls: number;
  /** Why a call did not produce candidates, in the provider's or transport's terms. */
  detail?: string;
}

export interface DiscoveryResult {
  /**
   * `ok` when at least one usable candidate was found. Otherwise the most
   * specific cause across the searches, with `unavailable` and `unconfigured`
   * outranking an empty result set: a broken provider must not read as "the
   * internet has no such product".
   */
  outcome: DiscoveryOutcome;
  /** Every query that was attempted, in the order it was sent. */
  queries: DiscoveryQuery[];
  attempts: DiscoveryAttempt[];
  /** Candidates across every query, de-duplicated by URL, in rank order. */
  candidates: DiscoveredCandidate[];
  /** External calls charged to the research ledger. */
  calls: number;
  /** Present when a research allowance, not the provider, ended the searches. */
  stopped?: DiscoveryStop;
}

/**
 * The search engine could not be reached, or refused to answer. Raised by the
 * provider and turned into an outcome by discovery, so a caller reading only the
 * result never sees an exception where an explicit answer is more useful.
 */
export class DiscoveryUnavailableError extends Error {
  constructor(detail: string) {
    super(`Discovery is unavailable: ${detail}`);
    this.name = "DiscoveryUnavailableError";
  }
}

/**
 * The search engine answered with something this application cannot read.
 * Raised rather than skipped so a provider change is noticed instead of
 * quietly becoming "no results".
 */
export class DiscoveryResponseError extends Error {
  constructor(detail: string) {
    super(`Discovery returned a malformed response: ${detail}`);
    this.name = "DiscoveryResponseError";
  }
}

export interface DiscoveryBounds {
  /** Searches one discovery may send, whatever the requirements ask for. */
  maxQueries: number;
  /** Results kept per search, so one broad query cannot flood a run. */
  maxResultsPerQuery: number;
  /** How long the provider has to answer one search. */
  requestTimeoutMs: number;
}

/**
 * Small on purpose: discovery is cheap compared with fetching pages, and a
 * shopper wants candidates to look at, not a crawl. Six searches cover two
 * languages over the handful of product phrases a requirement yields.
 */
export const DEFAULT_DISCOVERY_BOUNDS: DiscoveryBounds = {
  maxQueries: 6,
  maxResultsPerQuery: 8,
  requestTimeoutMs: 5_000,
};

/**
 * What one search costs. SearXNG runs on the operator's own machine, so there
 * is no bill; the call is still priced so the ledger can tell priced work from
 * unpriced work and so a deployment that puts a metered proxy in front of it
 * can say what a call is worth.
 */
export const DEFAULT_DISCOVERY_PRICING = { unitCents: 0, units: 1 } as const;

/** How long one search is expected to take, charged against a run's time limit. */
const ESTIMATED_SEARCH_DURATION_MS = 1_000;

/** A statement longer than this is a paragraph, not a product phrase. */
const MAXIMUM_PHRASE_LENGTH = 120;

/**
 * Words that describe the shopper rather than the product. A requirement may
 * mention them — "buy it for my daughter in Amsterdam" — and they would turn a
 * product search into a search for a person, so they are dropped.
 */
const NON_PRODUCT_WORDS = new Set([
  "account",
  "address",
  "amsterdam",
  "daughter",
  "deliver",
  "delivered",
  "delivery",
  "dochter",
  "email",
  "huisadres",
  "ik",
  "levering",
  "leveren",
  "me",
  "mijn",
  "my",
  "mij",
  "naam",
  "name",
  "nederland",
  "netherlands",
  "phone",
  "postcode",
  "son",
  "telefoon",
  "thuis",
  "zoon",
]);

/**
 * Wrappers that restate a requirement instead of adding to it. Dropped so the
 * query is the product and its attributes, not the sentence around them.
 */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "bijvoorbeeld",
  "de",
  "een",
  "en",
  "for",
  "het",
  "in",
  "is",
  "met",
  "moet",
  "must",
  "of",
  "om",
  "should",
  "the",
  "te",
  "to",
  "voor",
  "want",
  "wil",
  "with",
]);

/** Words that carry a limit but are noise once the phrase is sent to a shop. */
const COMPARISON_WORDS = new Set([
  "at",
  "least",
  "max",
  "maximaal",
  "maximum",
  "meer",
  "meest",
  "min",
  "minimaal",
  "minimum",
  "most",
  "ten",
  "tot",
  "under",
]);

const DUTCH_WORDS = new Set([
  "cm",
  "euro",
  "geen",
  "geschikt",
  "heeft",
  "kleur",
  "maat",
  "niet",
  "prijs",
  "tot",
  "uur",
  "waterdicht",
  "zonder",
  "zwart",
  "wit",
]);

/**
 * A statement reduced to the product phrase inside it, and the language it was
 * written in. A statement that says nothing about a product — "I want it soon"
 * — yields an empty phrase, and the query for it is then skipped rather than
 * sent as noise.
 */
function phraseOf(statement: string): { phrase: string; language: DiscoveryLanguage } {
  const words = statement
    .slice(0, MAXIMUM_PHRASE_LENGTH)
    .toLowerCase()
    // An email address, a postcode, and a house number are the shopper's
    // circumstances, not the product. They are removed whole rather than word by
    // word, because `example.com` would otherwise survive as two ordinary words.
    .replace(/\S+@\S+/g, " ")
    .replace(/\b\d{4}\s?[a-z]{2}\b/g, " ")
    // Prices and quantities are constraints for comparison, not shop keywords,
    // and a bare number in a search is usually a model number that narrows it
    // wrongly. Only a standalone number is dropped, so "model 4" keeps the word
    // and loses the digit.
    .replace(/(?<![\p{L}])\d+([.,]\d+)?(?![\p{L}])/gu, " ")
    .split(/[^\p{L}-]+/u)
    .filter((word) => word.length > 1)
    .filter((word) => !NON_PRODUCT_WORDS.has(word))
    .filter((word) => !FILLER_WORDS.has(word))
    .filter((word) => !COMPARISON_WORDS.has(word));
  const language: DiscoveryLanguage = words.some((word) => DUTCH_WORDS.has(word)) ? "nl" : "en";
  return { phrase: words.join(" ").trim(), language };
}

/**
 * A reference derived from what the query asks, not from who asked it. Two
 * shoppers wanting the same thing send the same reference, which is what makes
 * the ledger's record of a search free of conversation content while still
 * being stable enough to recognise a retry of the same search.
 *
 * It is a name-based UUID (version 8, per RFC 9562) because the ledger's
 * reference column is a uuid: the digest is laid out as one rather than the
 * column being widened for a string, so a retry is still recognised as the same
 * call.
 */
function referenceOf(text: string, language: DiscoveryLanguage): string {
  const digest = createHash("sha256").update(`discovery\n${language}\n${text}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 8 (application-defined) and the RFC 4122 variant, so the value is a
  // well-formed UUID and not merely uuid-shaped.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** The candidate queries for one requirement: the phrase, in its own language. */
function queriesFor(requirement: Requirement, language: DiscoveryLanguage): DiscoveryQuery[] {
  const { phrase } = phraseOf(requirement.statement);
  if (phrase.length === 0) return [];
  const text = language === "nl" ? `${phrase} kopen nederland` : `buy ${phrase} netherlands`;
  return [
    {
      reference: referenceOf(text, language),
      text,
      language,
      from: [requirement.statement],
    },
  ];
}

/**
 * Turns requirements into a small, bounded set of searches: the product phrases
 * themselves, in Dutch and in English. Hard constraints come first because a
 * product that fails one is not worth finding.
 *
 * Only requirement statements are read. A query never carries an account, an
 * address, or a message, because nothing else is passed in: the caller hands
 * over the requirements and nothing more.
 */
export function buildDiscoveryQueries(
  requirements: Requirements,
  { maxQueries = DEFAULT_DISCOVERY_BOUNDS.maxQueries }: { maxQueries?: number } = {},
): DiscoveryQuery[] {
  const ordered = [...requirements.hardConstraints, ...requirements.preferences];
  const chosen: DiscoveryQuery[] = [];
  const seen = new Set<string>();
  for (const requirement of ordered) {
    if (chosen.length >= maxQueries) break;
    // Both languages are offered for each phrase, so a Dutch shop and an
    // English-language retailer are both reachable from one requirement.
    for (const language of ["nl", "en"] as const) {
      for (const query of queriesFor(requirement, language)) {
        if (seen.has(query.text)) continue;
        seen.add(query.text);
        chosen.push(query);
      }
    }
  }
  return chosen.slice(0, maxQueries);
}

/** The SearXNG JSON response, as much of it as discovery relies on. */
interface SearxngResponse {
  results: unknown;
  number_of_results?: unknown;
}

/** One result before it has been read, so a bad one can be rejected on its own. */
interface RawResult {
  url: unknown;
  title: unknown;
  content: unknown;
  engine: unknown;
}

/**
 * Reads one result into a candidate, or rejects it. A result without an http(s)
 * URL is not a page worth fetching — a `mailto:` or a search-engine redirect is
 * not a candidate — so it is dropped rather than guessed at.
 */
function candidateOf(
  raw: RawResult,
  query: DiscoveryQuery,
  rank: number,
): DiscoveredCandidate | undefined {
  if (typeof raw.url !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw.url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  const title = unverifiedClaim(typeof raw.title === "string" ? raw.title : "");
  if (!title) return undefined;
  const snippet = typeof raw.content === "string" ? unverifiedClaim(raw.content) : undefined;
  return {
    // Fragments and trailing slashes make the same page look like two
    // candidates, which would be paid for twice by whoever fetches them.
    url: `${parsed.origin}${parsed.pathname}${parsed.search}`,
    domain: parsed.hostname,
    title,
    ...(snippet ? { snippet } : {}),
    provenance: {
      provider: "searxng",
      query: { reference: query.reference, text: query.text, language: query.language },
      rank,
    },
  };
}

/**
 * Reads a SearXNG JSON body. Anything that is not the documented shape is a
 * malformed response rather than an empty one: a provider that changed its
 * answer must not be reported to a shopper as "nothing found".
 */
export function readSearxngResponse(
  body: unknown,
  query: DiscoveryQuery,
  { maxResultsPerQuery = DEFAULT_DISCOVERY_BOUNDS.maxResultsPerQuery } = {},
): { candidates: DiscoveredCandidate[]; rejected: number } {
  if (typeof body !== "object" || body === null) {
    throw new DiscoveryResponseError("the body is not a JSON object");
  }
  const response = body as SearxngResponse;
  if (!Array.isArray(response.results)) {
    throw new DiscoveryResponseError("`results` is not an array");
  }
  const candidates: DiscoveredCandidate[] = [];
  let rejected = 0;
  for (const raw of response.results as RawResult[]) {
    if (candidates.length >= maxResultsPerQuery) break;
    if (typeof raw !== "object" || raw === null) {
      rejected += 1;
      continue;
    }
    const candidate = candidateOf(raw, query, candidates.length + 1);
    if (candidate) candidates.push(candidate);
    else rejected += 1;
  }
  return { candidates, rejected };
}

/**
 * One search engine, from discovery's point of view: one call, one answer. It
 * throws when it could not answer — unreachable, timed out, or unreadable — so
 * "did not answer" is never mistaken for "found nothing".
 */
export interface SearchProvider {
  search(query: DiscoveryQuery): Promise<{ candidates: DiscoveredCandidate[]; rejected: number }>;
}

/** What a provider failure means, once it is no longer an exception. */
interface ProviderFailure {
  outcome: "unavailable" | "malformed";
  detail: string;
}

/** Why a provider call failed, in terms a shopper-facing outcome can use. */
function classifyFailure(error: unknown): ProviderFailure {
  if (error instanceof DiscoveryResponseError) {
    return { outcome: "malformed", detail: error.message };
  }
  if (error instanceof DiscoveryUnavailableError) {
    return { outcome: "unavailable", detail: error.message };
  }
  if (error instanceof Error) {
    // A timeout, a refused connection, and a DNS failure all mean the same
    // thing to a shopper: the search engine did not answer. Only the name is
    // kept, because a message may carry the internal address of the instance.
    return { outcome: "unavailable", detail: error.name };
  }
  return { outcome: "unavailable", detail: "unknown failure" };
}

/**
 * A SearXNG instance over its JSON API. No key is sent or needed: the instance
 * is the operator's own, reached on the internal network.
 */
export function createSearxngProvider({
  baseUrl,
  bounds = DEFAULT_DISCOVERY_BOUNDS,
  fetch = globalThis.fetch,
}: {
  baseUrl: string;
  bounds?: DiscoveryBounds;
  /** Injected so a test can answer deterministically, and so a live check is explicit. */
  fetch?: typeof globalThis.fetch;
}): SearchProvider {
  // The instance may be mounted under a path, so the endpoint is resolved
  // against whatever base the operator configured rather than string-joined.
  const endpoint = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

  return {
    async search(query) {
      // `format=json` is the only parameter that is not the query itself, so
      // nothing about the shopper leaves beyond the words being searched for.
      endpoint.searchParams.set("q", query.text);
      endpoint.searchParams.set("format", "json");
      endpoint.searchParams.set("language", query.language === "nl" ? "nl-NL" : "en");
      const response = await fetch(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(bounds.requestTimeoutMs),
      });
      if (!response.ok) {
        throw new DiscoveryUnavailableError(`SearXNG answered ${response.status}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DiscoveryResponseError("the body is not JSON");
      }
      return readSearxngResponse(body, query, bounds);
    },
  };
}

/** How strongly an outcome says discovery is broken, when several searches disagree. */
const OUTCOME_SEVERITY: Record<Exclude<DiscoveryOutcome, "ok">, number> = {
  no_results: 0,
  inadequate: 1,
  malformed: 2,
  unavailable: 3,
  unconfigured: 4,
};

/** Why a discovery stopped before its queries ran out. */
export interface DiscoveryStop {
  /** The allowance that was reached, in the research ledger's terms. */
  reason: "call_limit" | "time_limit" | "run_target" | "conversation_ceiling" | "daily_ceiling";
  /** How many of the planned queries were never sent. */
  queriesNotSent: number;
}

export interface Discovery {
  /**
   * Finds candidate pages for a run's conversation. Every search is reserved
   * against the research ledger before it is sent, so a run that has reached a
   * limit stops here rather than at the provider.
   */
  candidates(userId: string, runId: string, conversationId: string): Promise<DiscoveryResult>;
}

export function createDiscovery({
  research,
  requirements,
  provider,
  bounds = DEFAULT_DISCOVERY_BOUNDS,
  pricing = DEFAULT_DISCOVERY_PRICING,
}: {
  research: Research;
  /** The engine's own requirements read, so discovery never reads the database itself. */
  requirements: { get(userId: string, conversationId: string): Promise<Requirements> };
  /** Absent when no SearXNG instance is configured; discovery then says so. */
  provider?: SearchProvider;
  bounds?: DiscoveryBounds;
  pricing?: { unitCents: number; units?: number };
}): Discovery {
  /** What one search costs the ledger, which is fixed because one search is one call. */
  const pricedCents = pricing.unitCents * (pricing.units ?? 1);

  /**
   * Closes one reservation against the ledger and reports what the run became.
   * Closing can itself be refused — the run was stopped while the call was in
   * flight — and that is reported as no run rather than thrown: a search that
   * already happened must not look like a crash, and the provider's own
   * failure, if any, is the more useful thing to pass on.
   */
  async function close(
    userId: string,
    reservationId: string,
    startedAt: number,
  ): Promise<ResearchRun | undefined> {
    try {
      // A search that failed still happened: the instance was asked and did not
      // answer, so it is settled rather than released. That is what makes a
      // broken provider visible in the ledger instead of free.
      return await research.settle(userId, {
        reservationId,
        actualCents: pricedCents,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof ResearchRunStateError) return undefined;
      throw error;
    }
  }

  return {
    async candidates(userId, runId, conversationId) {
      // Reading requirements first proves the conversation belongs to the
      // shopper before anything is spent, and it is the only input a query is
      // ever built from: no account, no address, no message.
      const shopperRequirements = await requirements.get(userId, conversationId);
      const queries = buildDiscoveryQueries(shopperRequirements, bounds);

      if (!provider) {
        // Not an empty result: nothing was searched, so reporting "no results"
        // would tell a shopper their product does not exist.
        return { outcome: "unconfigured", queries, attempts: [], candidates: [], calls: 0 };
      }

      const attempts: DiscoveryAttempt[] = [];
      const byUrl = new Map<string, DiscoveredCandidate>();
      let calls = 0;
      let stopped: DiscoveryStop | undefined;
      let planned = queries.length;

      for (const query of queries) {
        let reservationId: string;
        try {
          reservationId = (
            await research.reserve(userId, runId, {
              reference: query.reference,
              callKind: "retrieval",
              pricing,
              estimatedDurationMs: ESTIMATED_SEARCH_DURATION_MS,
            })
          ).id;
        } catch (error) {
          if (!(error instanceof ResearchAllowanceExhaustedError)) throw error;
          // The allowance, not the provider, ended discovery. What was already
          // found stays: it was paid for.
          stopped = {
            reason: error.reason as DiscoveryStop["reason"],
            queriesNotSent: planned,
          };
          break;
        }
        planned -= 1;
        calls += 1;

        const startedAt = Date.now();
        let search: { candidates: DiscoveredCandidate[]; rejected: number };
        try {
          search = await provider.search(query);
        } catch (error) {
          await close(userId, reservationId, startedAt);
          const failure = classifyFailure(error);
          attempts.push({
            query,
            outcome: failure.outcome,
            found: 0,
            calls: 1,
            detail: failure.detail,
          });
          continue;
        }

        const after = await close(userId, reservationId, startedAt);

        // The first query to find a page owns it, so a page is listed once with
        // the search that ranked it highest rather than under every query.
        for (const candidate of search.candidates) {
          if (!byUrl.has(candidate.url)) byUrl.set(candidate.url, candidate);
        }
        attempts.push({
          query,
          outcome:
            search.candidates.length > 0 ? "ok" : search.rejected > 0 ? "inadequate" : "no_results",
          found: search.candidates.length,
          calls: 1,
        });

        // A settlement pauses the run when the call exhausted an allowance, so
        // the next reservation would be refused. Stopping here saves a round
        // trip and reports the reason the ledger itself recorded.
        if (after?.state !== "running") {
          if (planned > 0) {
            stopped = {
              reason: (after?.pauseReason ?? "call_limit") as DiscoveryStop["reason"],
              queriesNotSent: planned,
            };
          }
          break;
        }
      }

      const candidates = [...byUrl.values()];
      const outcome: DiscoveryOutcome =
        candidates.length > 0 ? "ok" : worstOf(attempts, stopped);
      return {
        outcome,
        queries,
        attempts,
        candidates,
        calls,
        ...(stopped ? { stopped } : {}),
      };
    },
  };
}

/**
 * The outcome when nothing usable came back. A provider that could not be
 * reached, or that answered with something unreadable, outranks an empty result
 * set: telling a shopper "nothing found" when the search engine was down is the
 * one failure that would mislead them.
 */
function worstOf(attempts: DiscoveryAttempt[], stopped: DiscoveryStop | undefined): DiscoveryOutcome {
  const reached: Exclude<DiscoveryOutcome, "ok">[] = [];
  for (const attempt of attempts) {
    // A search that worked contributes nothing to the worst case: it is the
    // ones that did not that decide what the shopper is told.
    if (attempt.outcome !== "ok") reached.push(attempt.outcome);
  }
  // A run that ran out of allowance before its searches could answer has not
  // found out whether candidates exist, so it is inadequate rather than empty.
  if (stopped) reached.push("inadequate");
  // Requirements that name no product produce no queries at all.
  if (reached.length === 0) reached.push("inadequate");
  return reached.reduce((worst, next) =>
    OUTCOME_SEVERITY[next] > OUTCOME_SEVERITY[worst] ? next : worst,
  );
}
