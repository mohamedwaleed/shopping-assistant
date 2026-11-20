// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";

/**
 * Source reading policy (ticket 15).
 *
 * Retrieval itself — URL safety, destination validation, redirects, size and
 * time bounds — belongs to the ingestion fetch helper (`./retrieval` on the
 * fetch-bounds branch). This module owns what happens *around* a retrieval:
 *
 * - one in-flight request per host, with an optional minimum interval, so a
 *   run of research never turns into a burst against a retailer;
 * - public-request deduplication: two callers asking for the same URL while it
 *   is in flight share one retrieval, and a recently read page is served from
 *   the recorded result within its cache window;
 * - cache-context isolation: a result read under one context (different
 *   locale, source policy revision or adapter version) is never served to a
 *   caller in another;
 * - bounded Retry-After and backoff honouring, so a 429 or 503 slows the host
 *   down for at most the configured ceiling instead of being retried blindly;
 * - access blocks are recorded and respected. A challenge page, a 403 or a
 *   robots/terms restriction is an observation about the source, never
 *   something to work around.
 */

/** Hard ceilings: a per-host override cannot exceed these. */
export const HOST_COORDINATION_LIMITS = {
  maxConcurrent: 8,
  maxMinimumIntervalMs: 60_000,
} as const;

/** Wait for a host slot before giving up, and how long to poll for one. */
export const HOST_SLOT_WAIT_MS = 10_000;
export const HOST_SLOT_POLL_MS = 25;
/** A request whose worker vanished stops blocking its host after this long. */
export const STALE_REQUEST_MS = 120_000;

/** Default public cache window for a successfully read page. */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** The longest a Retry-After or backoff may hold a host. */
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

export interface HostCoordination {
  maxConcurrent: number;
  minimumIntervalMs: number;
}

export const DEFAULT_HOST_COORDINATION: HostCoordination = {
  maxConcurrent: 1,
  minimumIntervalMs: 1_000,
};

export type AccessBlockReason = "robots" | "terms" | "challenge" | "rate-limited" | "forbidden";

export interface AccessBlock {
  host: string;
  url: string;
  reason: AccessBlockReason;
  /** What on the response said so, e.g. `http-429` or `challenge-page`. */
  signal: string;
  statusCode: number | null;
  observedAt: string;
  /** When the source itself asked us to come back, if it said so. */
  retryAfterAt: string | null;
}

/** A page read through the source reader, with where and when it was read. */
export interface SourcePage {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  fetchedAt: string;
  /** The `Cache-Control: max-age` the source itself stated, if any. */
  sourceMaxAgeSeconds: number | null;
  /** The cache-context key the page was read under. */
  cacheContext: string;
}

export interface CacheContext {
  /** Who reads the page. The catalogue is public, so this is a stable label. */
  scope: string;
  /** Anything else that changes what a correct reading means. */
  revision?: string;
}

export interface SourceReaderDependencies {
  db: Knex;
  /**
   * The bounded retrieval. The fetch-bounds branch supplies the real one; this
   * reader only decides when to call it.
   */
  retrieve: (url: string) => Promise<Response>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Waits for the lock that serializes slot assignment per host. */
  lockTimeoutMs?: number;
}

export type SourceReadOutcome =
  | { kind: "read"; page: SourcePage; replayed: boolean }
  | { kind: "blocked"; block: AccessBlock }
  | { kind: "failed"; classification: "http" | "network" | "redirect"; status?: number }
  | { kind: "host-busy"; host: string };

const CHALLENGE_PATTERN = /captcha|verify you are human|security checkpoint|access denied|controleer of je een mens bent/i;

/** The cache-context key: a page read for one context never serves another. */
export function cacheContextKey(context: CacheContext): string {
  return context.revision ? `${context.scope}#${context.revision}` : context.scope;
}

/** Parse Retry-After (seconds or HTTP-date), bounded by the configured ceiling. */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) * 1_000 : null;
  const date = seconds === null ? Date.parse(trimmed) - now.getTime() : null;
  const value = seconds ?? date;
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 0), MAX_RETRY_AFTER_MS);
}

function cacheControlMaxAge(header: string | null): number | null {
  if (!header) return null;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(header);
  return match ? Number(match[1]) : null;
}

export interface SourceReader {
  read(url: string, context: CacheContext): Promise<SourceReadOutcome>;
  /** The access blocks recorded for a host, newest first. */
  blocks(host: string, limit?: number): Promise<AccessBlock[]>;
  /** Record a source restriction observed outside a fetch (robots, terms). */
  recordBlock(input: { url: string; reason: "robots" | "terms"; signal: string }): Promise<void>;
  /** Per-host coordination as stored, falling back to the defaults. */
  coordination(host: string): Promise<HostCoordination>;
  saveCoordination(host: string, input: HostCoordination): Promise<Result<HostCoordination>>;
}

interface RequestRow {
  id: string;
  url: string;
  host: string;
  state: "in_flight" | "complete";
  outcome: string;
  cache_context: string;
  attempts: number;
  fetched_at: Date | string | null;
  expires_at: Date | string;
  created_at: Date | string;
}

export function createSourceReader(deps: SourceReaderDependencies): SourceReader {
  const { db, retrieve } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function coordination(host: string): Promise<HostCoordination> {
    const row = await db("source_host_policies").where({ host }).first();
    return row
      ? { maxConcurrent: Number(row.max_concurrent), minimumIntervalMs: Number(row.minimum_interval_ms) }
      : DEFAULT_HOST_COORDINATION;
  }

  async function saveCoordination(host: string, input: HostCoordination): Promise<Result<HostCoordination>> {
    if (!host.trim()) return err({ kind: "invalid-input", field: "host", message: "host must not be blank" });
    if (
      !Number.isInteger(input.maxConcurrent) ||
      input.maxConcurrent < 1 ||
      input.maxConcurrent > HOST_COORDINATION_LIMITS.maxConcurrent
    ) {
      return err({
        kind: "invalid-input",
        field: "maxConcurrent",
        message: `maxConcurrent must be a whole number between 1 and ${HOST_COORDINATION_LIMITS.maxConcurrent}`,
      });
    }
    if (
      !Number.isInteger(input.minimumIntervalMs) ||
      input.minimumIntervalMs < 0 ||
      input.minimumIntervalMs > HOST_COORDINATION_LIMITS.maxMinimumIntervalMs
    ) {
      return err({
        kind: "invalid-input",
        field: "minimumIntervalMs",
        message: `minimumIntervalMs must be between 0 and ${HOST_COORDINATION_LIMITS.maxMinimumIntervalMs}`,
      });
    }
    await db("source_host_policies")
      .insert({ host, max_concurrent: input.maxConcurrent, minimum_interval_ms: input.minimumIntervalMs, updated_at: now() })
      .onConflict("host")
      .merge();
    return ok({ ...input });
  }

  async function blocks(host: string, limit = 20): Promise<AccessBlock[]> {
    const rows = await db("source_access_blocks")
      .where({ host })
      .orderBy("observed_at", "desc")
      .limit(limit);
    return rows.map((row) => ({
      host: row.host,
      url: row.url,
      reason: row.reason,
      signal: row.signal,
      statusCode: row.status_code === null ? null : Number(row.status_code),
      observedAt: new Date(row.observed_at).toISOString(),
      retryAfterAt: row.retry_after_at ? new Date(row.retry_after_at).toISOString() : null,
    }));
  }

  async function record(block: AccessBlock): Promise<AccessBlock> {
    await db("source_access_blocks").insert({
      host: block.host,
      url: block.url,
      reason: block.reason,
      signal: block.signal,
      status_code: block.statusCode,
      observed_at: new Date(block.observedAt),
      retry_after_at: block.retryAfterAt ? new Date(block.retryAfterAt) : null,
    });
    return block;
  }

  async function recordBlock(input: { url: string; reason: "robots" | "terms"; signal: string }): Promise<void> {
    const url = new URL(input.url);
    await record({
      host: url.hostname,
      url: input.url,
      reason: input.reason,
      signal: input.signal,
      statusCode: null,
      observedAt: now().toISOString(),
      retryAfterAt: null,
    });
  }

  /**
   * The newest block still in force for this host: a challenge or refusal is
   * respected until its Retry-After passes; robots/terms restrictions have no
   * expiry because only a person can withdraw them.
   */
  async function activeBlock(host: string, at: Date): Promise<AccessBlock | null> {
    const recent = await blocks(host, 5);
    return (
      recent.find(
        (block) =>
          block.reason === "robots" ||
          block.reason === "terms" ||
          (block.retryAfterAt !== null && Date.parse(block.retryAfterAt) > at.getTime()),
      ) ?? null
    );
  }

  /**
   * Take a host slot. Assignment is serialized with an advisory lock so two
   * workers cannot both see "one slot free" and both take it; the wait for a
   * slot is bounded so a busy host never holds a request open indefinitely.
   */
  async function acquire(
    host: string,
    at: Date,
    url: string,
    key: string,
  ): Promise<{ kind: "reserved"; id: string } | { kind: "busy" }> {
    const policy = await coordination(host);
    const deadline = at.getTime() + (deps.lockTimeoutMs ?? HOST_SLOT_WAIT_MS);
    for (;;) {
      // One transaction: the interval decision and the reservation it allows
      // are made together, so a worker that waited out the interval cannot then
      // find the slot taken and start a second interval.
      const slot = await db.transaction(async (trx) => {
        await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`source-host:${host}`]);
        const staleBefore = new Date(now().getTime() - STALE_REQUEST_MS);
        await trx("source_requests")
          .where({ host, state: "in_flight" })
          .where("created_at", "<", staleBefore)
          .update({ state: "complete", outcome: "abandoned", completed_at: now() });
        const inFlight = await trx("source_requests")
          .where({ host, state: "in_flight" })
          .orderBy("created_at", "asc")
          .select("created_at");
        if (inFlight.length >= policy.maxConcurrent) return { kind: "busy" as const };
        const last = inFlight.at(-1);
        const wait = last
          ? policy.minimumIntervalMs - (now().getTime() - new Date(last.created_at).getTime())
          : 0;
        if (wait > 0) return { kind: "wait" as const, wait };
        await trx("source_requests")
          .insert({
            url,
            host,
            state: "in_flight",
            outcome: "pending",
            cache_context: key,
            attempts: 1,
            expires_at: new Date(now().getTime() + DEFAULT_CACHE_TTL_MS),
            created_at: now(),
          })
          .onConflict("url")
          .merge(["state", "outcome", "cache_context", "attempts", "expires_at", "created_at", "completed_at"]);
        const reserved = await trx("source_requests").where({ url }).first();
        return { kind: "reserved" as const, id: reserved.id as string };
      });
      if (slot.kind === "reserved") return slot;
      if (slot.kind === "busy") {
        if (now().getTime() >= deadline) return { kind: "busy" };
        await sleep(HOST_SLOT_POLL_MS);
        continue;
      }
      // Minimum interval not yet elapsed: wait it out, still within the bound.
      const remaining = Math.min(slot.wait, Math.max(deadline - now().getTime(), 0));
      if (remaining <= 0) return { kind: "busy" };
      await sleep(remaining);
    }
  }

  function pageOf(url: string, context: string, response: Response, html: string, fetchedAt: Date): SourcePage {
    const maxAge = cacheControlMaxAge(response.headers.get("cache-control"));
    return {
      url,
      finalUrl: response.url || url,
      status: response.status,
      html,
      fetchedAt: fetchedAt.toISOString(),
      sourceMaxAgeSeconds: maxAge,
      cacheContext: context,
    };
  }

  async function read(url: string, context: CacheContext): Promise<SourceReadOutcome> {
    const key = cacheContextKey(context);
    const target = new URL(url);
    const host = target.hostname;
    const at = now();

    const blocked = await activeBlock(host, at);
    if (blocked) return { kind: "blocked", block: blocked };

    // Public-request deduplication. A complete row in the same cache context
    // inside its window is served as recorded; an in-flight row in the same
    // context is awaited rather than re-fetched. A row from another context is
    // never consulted: it says nothing about this caller's reading.
    const existing = (await db("source_requests").where({ url }).first()) as RequestRow | undefined;
    const sameContext = existing?.cache_context === key;
    const inFlight = existing?.state === "in_flight";
    const expired =
      !sameContext || existing.fetched_at === null
        ? true
        : new Date(existing.fetched_at).getTime() + ttl(existing) <= at.getTime();
    if (existing && sameContext) {
      // A row that is being read right now is awaited first, whatever its
      // window: its own read is the answer to this request.
      if (inFlight && at.getTime() - new Date(existing.created_at).getTime() < STALE_REQUEST_MS) {
        return await waitForCompletion(url, key);
      }
      if (!expired && existing.outcome === "read") {
        const page = await cachedPage(existing);
        if (page) return { kind: "read", page, replayed: true };
      }
    }

    // A different cache context must not share a row, and an expired row is
    // retired before the slot is taken so the retry itself is not blocked by
    // its own in-flight row.
    if (existing) {
      await db("source_requests").where({ id: existing.id }).update({ state: "complete", outcome: "superseded", completed_at: now() });
    }

    const slot = await acquire(host, at, url, key);
    if (slot.kind === "busy") return { kind: "host-busy", host };

    const id = slot.id;

    let response: Response;
    const startedAt = now();
    try {
      response = await retrieve(url);
    } catch {
      await finish(id, "failed");
      return { kind: "failed", classification: "network" };
    }

    const retryAfter = retryAfterMs(response.headers.get("retry-after"), now());
    const retryAfterAt = retryAfter === null ? null : new Date(now().getTime() + retryAfter).toISOString();

    if (response.status === 429 || response.status === 503) {
      await finish(id, "blocked");
      const block = await record({
        host,
        url,
        reason: "rate-limited",
        signal: `http-${response.status}`,
        statusCode: response.status,
        observedAt: now().toISOString(),
        retryAfterAt,
      });
      return { kind: "blocked", block };
    }
    if (response.status === 403) {
      await finish(id, "blocked");
      const block = await record({
        host,
        url,
        reason: "forbidden",
        signal: "http-403",
        statusCode: 403,
        observedAt: now().toISOString(),
        retryAfterAt,
      });
      return { kind: "blocked", block };
    }

    const html = await response.text();
    if (CHALLENGE_PATTERN.test(html)) {
      await finish(id, "blocked");
      const block = await record({
        host,
        url,
        reason: "challenge",
        signal: "challenge-page",
        statusCode: response.status,
        observedAt: now().toISOString(),
        retryAfterAt,
      });
      return { kind: "blocked", block };
    }
    if (!response.ok) {
      await finish(id, "failed");
      return { kind: "failed", classification: "http", status: response.status };
    }

    const page = pageOf(url, key, response, html, startedAt);
    await db("source_requests").where({ id }).update({
      state: "complete",
      outcome: "read",
      fetched_at: startedAt,
      expires_at: new Date(startedAt.getTime() + ttlFor(page)),
      completed_at: now(),
    });
    return { kind: "read", page, replayed: false };
  }

  async function finish(id: string, outcome: string): Promise<void> {
    await db("source_requests").where({ id }).update({ state: "complete", outcome, completed_at: now() });
  }

  /** Wait, bounded, for the worker that holds the in-flight row. */
  async function waitForCompletion(url: string, key: string): Promise<SourceReadOutcome> {
    // Waiting for a concurrent request is real elapsed time, not simulated
    // clock time: the other worker completes in its own time.
    const waitSleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (deps.lockTimeoutMs ?? HOST_SLOT_WAIT_MS);
    while (Date.now() < deadline) {
      await waitSleep(HOST_SLOT_POLL_MS);
      const row = (await db("source_requests").where({ url }).first()) as RequestRow | undefined;
      if (!row) return { kind: "failed", classification: "network" };
      if (row.state === "in_flight") continue;
      if (row.cache_context !== key) return { kind: "failed", classification: "network" };
      if (row.outcome === "read") {
        const page = await cachedPage(row);
        if (page) return { kind: "read", page, replayed: true };
      }
      if (row.outcome === "blocked") {
        const block = await activeBlock(row.host, now());
        if (block) return { kind: "blocked", block };
      }
      return { kind: "failed", classification: "http" };
    }
    return { kind: "failed", classification: "network" };
  }

  function ttl(row: RequestRow): number {
    // The window is the gap between the read and its expiry, both stored.
    return new Date(row.expires_at).getTime() - new Date(row.fetched_at ?? row.created_at).getTime();
  }

  /** A recorded read, rebuilt from the evidence row it produced. */
  async function cachedPage(row: RequestRow): Promise<SourcePage | null> {
    const evidence = await db("source_evidence").where({ source_url: row.url }).first();
    if (!evidence) return null;
    return {
      url: row.url,
      finalUrl: evidence.final_url,
      status: 200,
      html: evidence.excerpt,
      fetchedAt: new Date(row.fetched_at ?? row.created_at).toISOString(),
      sourceMaxAgeSeconds: null,
      cacheContext: row.cache_context,
    };
  }

  function ttlFor(page: SourcePage): number {
    const stated = page.sourceMaxAgeSeconds === null ? null : page.sourceMaxAgeSeconds * 1_000;
    return Math.min(stated ?? DEFAULT_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
  }

  return { read, blocks, recordBlock, coordination, saveCoordination };
}
