// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createSourceReader,
  MAX_RETRY_AFTER_MS,
  type SourceReader,
} from "../src/ingestion/source-reader";

// Source reading through the core against real PostgreSQL: coordination,
// deduplication, cache-context isolation, bounded Retry-After and access
// blocks are all storage-visible behaviour, so they are proven where they
// happen rather than against an in-memory double.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const PUBLIC = { scope: "public-catalogue", revision: "1" };

interface Recorded {
  url: string;
  at: number;
}

describe("resilient source reading", () => {
  let db: Knex;
  let clock: Date;
  let inFlight: number;
  let peak: number;
  let fetched: Recorded[];
  let respond: (url: string) => Response;
  let reader: SourceReader;

  const now = () => clock;
  const sleep = async (ms: number) => {
    // Simulated host waiting advances the clock; a wait for another worker's
    // request is real elapsed time and must not be simulated.
    await new Promise((resolve) => setTimeout(resolve, 1));
    clock = new Date(clock.getTime() + ms);
  };

  function build(): SourceReader {
    return createSourceReader({
      db,
      now,
      sleep,
      retrieve: async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        fetched.push({ url, at: clock.getTime() });
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return respond(url);
      },
    });
  }

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
  });

  beforeEach(async () => {
    await db("source_access_blocks").delete();
    await db("source_requests").delete();
    await db("source_host_policies").delete();
    await db("source_evidence").delete();
    clock = new Date("2026-11-19T10:00:00Z");
    inFlight = 0;
    peak = 0;
    fetched = [];
    respond = () => new Response("<html><h1>ok</h1></html>", { status: 200 });
    reader = build();
  });

  afterAll(async () => {
    await db.destroy();
  });

  /** Give a read something to replay: a recorded evidence row for its URL. */
  async function evidenceFor(url: string, finalUrl = url) {
    await db("source_evidence").insert({
      source_url: url,
      final_url: finalUrl,
      excerpt: "<html><h1>recorded</h1></html>",
      observed_at: clock,
    });
  }

  it("never runs more retrievals against one host than its slot allows", async () => {
    const reads = await Promise.all(
      ["a", "b", "c"].map((slug) => reader.read(`https://www.coolblue.nl/product/${slug}`, PUBLIC)),
    );

    expect(reads.map((read) => read.kind)).toEqual(["read", "read", "read"]);
    // One slot per host by default: three different URLs still never overlap.
    expect(peak).toBe(1);
    expect(fetched).toHaveLength(3);
  });

  it("honours a stored per-host concurrency and minimum interval", async () => {
    expect(await reader.saveCoordination("www.coolblue.nl", { maxConcurrent: 2, minimumIntervalMs: 500 })).toMatchObject({
      ok: true,
    });
    // A slow source, so a retrieval is still open when the next start is due;
    // otherwise real latency would mask whether the interval is honoured.
    const slow = createSourceReader({
      db,
      now,
      sleep,
      retrieve: async (url) => {
        fetched.push({ url, at: clock.getTime() });
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response("<html><h1>ok</h1></html>", { status: 200 });
      },
    });

    const urls = ["a", "b", "c", "d"].map((slug) => `https://www.coolblue.nl/product/${slug}`);
    await Promise.all(urls.map((url) => slow.read(url, PUBLIC)));

    // Two slots are permitted, and every start is at least the interval after
    // the previous one, so the interval is what serializes the host.
    expect(fetched).toHaveLength(4);
    const starts = fetched.map((entry) => entry.at);
    const gaps = starts.slice(1).map((start, index) => start - starts[index]!);
    expect(gaps.every((gap) => gap >= 500)).toBe(true);
  });

  it("lets two slots overlap when the interval does not serialize them", async () => {
    expect(await reader.saveCoordination("www.coolblue.nl", { maxConcurrent: 2, minimumIntervalMs: 0 })).toMatchObject({
      ok: true,
    });
    // A slow source, so the two slots are genuinely occupied at the same time.
    const slow = createSourceReader({
      db,
      now,
      sleep,
      retrieve: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 40));
        inFlight -= 1;
        return new Response("<html><h1>ok</h1></html>", { status: 200 });
      },
    });

    await Promise.all(
      ["a", "b", "c", "d"].map((slug) => slow.read(`https://www.coolblue.nl/product/${slug}`, PUBLIC)),
    );

    expect(peak).toBe(2);
  });

  it("refuses coordination outside the hard ceilings instead of clamping", async () => {
    expect(await reader.saveCoordination("www.bol.com", { maxConcurrent: 9, minimumIntervalMs: 0 })).toEqual({
      ok: false,
      error: {
        kind: "invalid-input",
        field: "maxConcurrent",
        message: "maxConcurrent must be a whole number between 1 and 8",
      },
    });
    expect(await reader.saveCoordination("www.bol.com", { maxConcurrent: 1, minimumIntervalMs: 60_001 })).toMatchObject({
      ok: false,
      error: { field: "minimumIntervalMs" },
    });
  });

  it("serves a recently read page from its recorded result instead of fetching again", async () => {
    const url = "https://www.coolblue.nl/product/869952";
    const first = await reader.read(url, PUBLIC);
    expect(first).toMatchObject({ kind: "read", replayed: false });
    await evidenceFor(url);

    clock = new Date(clock.getTime() + 60_000);
    const second = await reader.read(url, PUBLIC);

    expect(second).toMatchObject({ kind: "read", replayed: true });
    expect(fetched).toHaveLength(1);
    if (second.kind !== "read") return;
    expect(second.page.fetchedAt).toBe("2026-11-19T10:00:00.000Z");
  });

  it("fetches again once the cache window has passed", async () => {
    const url = "https://www.coolblue.nl/product/869952";
    await evidenceFor(url);
    await reader.read(url, PUBLIC);

    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    const again = await reader.read(url, PUBLIC);

    expect(again).toMatchObject({ kind: "read", replayed: false });
    expect(fetched).toHaveLength(2);
  });

  it("never serves a result read under another cache context", async () => {
    const url = "https://www.coolblue.nl/product/869952";
    await evidenceFor(url);
    await reader.read(url, PUBLIC);

    const other = await reader.read(url, { scope: "public-catalogue", revision: "2" });

    expect(other).toMatchObject({ kind: "read", replayed: false });
    expect(fetched).toHaveLength(2);
    if (other.kind !== "read") return;
    expect(other.page.cacheContext).toBe("public-catalogue#2");
  });

  it("collapses simultaneous public requests for the same URL into one retrieval", async () => {
    const url = "https://www.bol.com/nl/nl/p/x/1/";
    await evidenceFor(url);

    // Hold the retrieval open so the second request is unambiguously
    // simultaneous with it rather than merely racing to start first.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = createSourceReader({
      db,
      now,
      sleep,
      retrieve: async (requested) => {
        fetched.push({ url: requested, at: clock.getTime() });
        await held;
        return new Response("<html><h1>ok</h1></html>", { status: 200 });
      },
    });

    const first = slow.read(url, PUBLIC);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = slow.read(url, PUBLIC);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(fetched.filter((entry) => entry.url === url)).toHaveLength(1);
    // One retrieval, two callers: both are served that result.
    expect([a.kind, b.kind]).toEqual(["read", "read"]);
    expect([a, b].map((read) => (read.kind === "read" ? read.replayed : null))).toContain(false);
  });

  it("records a rate limit with a bounded Retry-After and respects it before asking again", async () => {
    respond = () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });

    const first = await reader.read("https://www.coolblue.nl/product/a", PUBLIC);
    expect(first).toMatchObject({ kind: "blocked", block: { reason: "rate-limited", signal: "http-429", statusCode: 429 } });
    if (first.kind !== "blocked") return;
    // An hour was asked for; the ceiling is fifteen minutes.
    expect(first.block.retryAfterAt).toBe(new Date(clock.getTime() + MAX_RETRY_AFTER_MS).toISOString());

    respond = () => new Response("<html><h1>ok</h1></html>", { status: 200 });
    clock = new Date(clock.getTime() + 60_000);
    const whileBlocked = await reader.read("https://www.coolblue.nl/product/b", PUBLIC);

    expect(whileBlocked).toMatchObject({ kind: "blocked", block: { reason: "rate-limited" } });
    expect(fetched).toHaveLength(1);

    clock = new Date(clock.getTime() + MAX_RETRY_AFTER_MS);
    const afterWindow = await reader.read("https://www.coolblue.nl/product/b", PUBLIC);
    expect(afterWindow).toMatchObject({ kind: "read" });
  });

  it("records a challenge page and a refusal as access blocks rather than working around them", async () => {
    respond = () => new Response("<html><h1>Controleer of je een mens bent</h1></html>", { status: 200 });
    const challenge = await reader.read("https://www.coolblue.nl/product/c", PUBLIC);
    expect(challenge).toMatchObject({ kind: "blocked", block: { reason: "challenge", signal: "challenge-page", statusCode: 200 } });

    const forbidden = await reader.read("https://www.bol.com/nl/nl/p/y/2/", PUBLIC);
    expect(forbidden).toMatchObject({ kind: "blocked" });

    respond = () => new Response("no", { status: 403 });
    await db("source_access_blocks").delete();
    const refused = await reader.read("https://www.bol.com/nl/nl/p/y/3/", PUBLIC);
    expect(refused).toMatchObject({ kind: "blocked", block: { reason: "forbidden", signal: "http-403" } });

    // The blocks are inspectable per host, newest first.
    const recorded = await reader.blocks("www.bol.com");
    expect(recorded.map((block) => block.reason)).toEqual(["forbidden"]);
  });

  it("respects a robots or terms restriction until a person withdraws it", async () => {
    await reader.recordBlock({ url: "https://www.bol.com/nl/nl/p/z/4/", reason: "terms", signal: "no-resale" });

    clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000);
    const later = await reader.read("https://www.bol.com/nl/nl/p/z/5/", PUBLIC);

    expect(later).toMatchObject({ kind: "blocked", block: { reason: "terms", signal: "no-resale" } });
    expect(fetched).toEqual([]);
  });

  it("reports a busy host instead of waiting forever when every slot stays held", async () => {
    // One slot, held by a retrieval that never finishes. The second request
    // must give up within its bound rather than hang, and it must not have
    // fetched: the slot it could not take was never free.
    const held = createSourceReader({
      db,
      now,
      sleep,
      lockTimeoutMs: 150,
      retrieve: async () => new Promise<Response>(() => undefined),
    });

    void held.read("https://www.coolblue.nl/product/holder", PUBLIC);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const refused = await held.read("https://www.coolblue.nl/product/waiter", PUBLIC);

    expect(refused).toEqual({ kind: "host-busy", host: "www.coolblue.nl" });
  });

  it("reports an HTTP failure as a failed read without recording a block", async () => {
    respond = () => new Response("gone", { status: 410 });

    const failed = await reader.read("https://www.coolblue.nl/product/d", PUBLIC);

    expect(failed).toEqual({ kind: "failed", classification: "http", status: 410 });
    expect(await reader.blocks("www.coolblue.nl")).toEqual([]);
  });
});
