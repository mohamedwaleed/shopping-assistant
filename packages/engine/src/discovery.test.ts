import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createAccount, createTestSchema, migrate } from "@shopping-assistant/database/testing";
import {
  buildDiscoveryQueries,
  ConversationNotFoundError,
  createEngine,
  createSearxngProvider,
  DEFAULT_DISCOVERY_BOUNDS,
  DiscoveryResponseError,
  DiscoveryUnavailableError,
  readSearxngResponse,
  unverifiedClaim,
  type DiscoveryQuery,
  type Engine,
  type Requirements,
} from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

/**
 * Recorded SearXNG JSON, trimmed to the fields discovery reads. Nothing here
 * reaches the internet: the recorded bodies are the provider, so the suite runs
 * offline and answers the same way every time.
 */
const SEARXNG_BIKE_HELMET_NL = {
  query: "waterdicht fietshelm kopen nederland",
  number_of_results: 3,
  results: [
    {
      url: "https://www.fietshelmwinkel.nl/waterdichte-fietshelm-zwart",
      title: "Waterdichte fietshelm zwart - Fietshelmwinkel",
      content: "Waterdichte fietshelm in het zwart, geleverd binnen 2 dagen.",
      engine: "brave",
      score: 1.2,
      category: "general",
    },
    {
      url: "https://www.helmstore.nl/producten/fietshelm-regen#reviews",
      title: "Regenbestendige fietshelm | Helmstore",
      content: "Regenbestendige fietshelm voor woon-werkverkeer.",
      engine: "duckduckgo",
      score: 0.9,
      category: "general",
    },
    {
      url: "mailto:info@fietshelmwinkel.nl",
      title: "Contact",
      content: "Mail ons.",
      engine: "brave",
    },
  ],
};

const SEARXNG_BIKE_HELMET_EN = {
  query: "buy waterdicht fietshelm netherlands",
  number_of_results: 2,
  results: [
    {
      // The same page as the Dutch result, with a different fragment, so
      // de-duplication is exercised by real-shaped data.
      url: "https://www.helmstore.nl/producten/fietshelm-regen",
      title: "Waterproof bike helmet | Helmstore",
      content: "Waterproof bike helmet for commuting.",
      engine: "google",
    },
    {
      url: "https://www.bikegear.eu/helmets/rain-commuter",
      title: "Rain Commuter Helmet - BikeGear",
      content: "A commuter helmet built for Dutch weather.",
      engine: "google",
    },
  ],
};

/** A recorded answer from an instance that found nothing for a query. */
const SEARXNG_NO_RESULTS = { query: "", number_of_results: 0, results: [] };

/**
 * A provider that answers each query from a recorded body, keyed by query text.
 * A query with no recording answers with a recorded empty result set, which is
 * what a real instance returns for a query it has nothing for.
 */
function recordedProvider(bodies: Record<string, unknown>) {
  const sent: { text: string; language: string; url: string; accept: string | null }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const text = url.searchParams.get("q") ?? "";
    sent.push({
      text,
      language: url.searchParams.get("language") ?? "",
      url: url.toString(),
      accept: new Headers(init?.headers).get("accept"),
    });
    const body = bodies[text] ?? SEARXNG_NO_RESULTS;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

let server: Database;

interface Installation {
  database: Database;
  engine: Engine;
  shopperId: string;
  conversationId: string;
  drop: () => Promise<void>;
}

async function createInstallation({
  fetch,
  bounds,
  researchCeilings,
  requirements = {
    hardConstraints: [{ statement: "A waterproof bike helmet, black" }],
    preferences: [],
  },
}: {
  fetch?: typeof globalThis.fetch;
  bounds?: { maxQueries: number; maxResultsPerQuery: number; requestTimeoutMs: number };
  researchCeilings?: { callLimit?: number };
  requirements?: { hardConstraints: { statement: string }[]; preferences: { statement: string }[] };
} = {}): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  // A SearXNG URL is configured by default: it is what a working installation
  // has, and a test that wants none builds its own engine.
  const engine = createEngine({
    database,
    setupToken: "unused-in-these-tests",
    identity: createFakeIdentityStore(database),
    services: { discovery: { searxngUrl: "http://searxng:8080" } },
    ...(researchCeilings ? { researchCeilings } : {}),
    ...(fetch || bounds
      ? { discovery: { ...(fetch ? { fetch } : {}), ...(bounds ? { bounds } : {}) } }
      : {}),
  });
  const shopperId = await createAccount(database, "shopper@example.com");
  const conversation = await engine.conversations.create(shopperId, { title: "Bike helmet" });
  await engine.requirements.set(shopperId, conversation.id, requirements);
  return { database, engine, shopperId, conversationId: conversation.id, drop };
}

async function discard(installation: Installation): Promise<void> {
  await installation.database.destroy();
  await installation.drop();
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

const REQUIREMENTS: Requirements = {
  hardConstraints: [
    {
      id: "1",
      kind: "hard_constraint",
      statement: "A waterproof bike helmet, black",
      createdAt: new Date("2026-11-28T09:00:00.000Z"),
    },
  ],
  preferences: [
    {
      id: "2",
      kind: "preference",
      statement: "Delivered to the Netherlands",
      createdAt: new Date("2026-11-28T09:00:00.000Z"),
    },
  ],
  summary: "unused here",
};

describe("discovery queries", () => {
  it("builds minimal Dutch and English product queries from the requirements", () => {
    const queries = buildDiscoveryQueries(REQUIREMENTS);

    expect(queries.map((query) => [query.language, query.text])).toEqual([
      ["nl", "waterproof bike helmet black kopen nederland"],
      ["en", "buy waterproof bike helmet black netherlands"],
    ]);
    // Every query names the requirement it came from, so the shopper can see
    // what was searched for without reading a payload.
    expect(queries[0]?.from).toEqual(["A waterproof bike helmet, black"]);
  });

  it("drops account details, addresses, and delivery talk from a query", () => {
    const queries = buildDiscoveryQueries({
      ...REQUIREMENTS,
      hardConstraints: [
        {
          id: "3",
          kind: "hard_constraint",
          statement:
            "Waterproof bike helmet for my daughter, deliver to shopper@example.com at Postcode 1012AB",
          createdAt: new Date("2026-11-28T09:00:00.000Z"),
        },
      ],
      preferences: [],
    });

    for (const query of queries) {
      expect(query.text).not.toContain("example.com");
      expect(query.text).not.toContain("1012AB");
      expect(query.text).not.toContain("shopper");
      expect(query.text).not.toContain("daughter");
    }
    expect(queries[0]?.text).toBe("waterproof bike helmet kopen nederland");
  });

  it("bounds the number of queries however many requirements a shopper writes", () => {
    const products = ["helmet", "lock", "light", "bell", "mirror", "rack", "pump", "saddle"];
    const many: Requirements = {
      hardConstraints: products.map((product, index) => ({
        id: `${index}`,
        kind: "hard_constraint" as const,
        statement: `A waterproof bike ${product} in black`,
        createdAt: new Date("2026-11-28T09:00:00.000Z"),
      })),
      preferences: [],
      summary: "unused here",
    };

    // Two languages each for eight products would be sixteen searches; the
    // bound is what a run pays for, so it wins.
    expect(buildDiscoveryQueries(many)).toHaveLength(DEFAULT_DISCOVERY_BOUNDS.maxQueries);
    expect(buildDiscoveryQueries(many, { maxQueries: 2 })).toHaveLength(2);
  });

  it("sends nothing for a requirement that names no product", () => {
    expect(
      buildDiscoveryQueries({ hardConstraints: [], preferences: [], summary: "none" }),
    ).toEqual([]);
  });

  it("gives the same query the same reference and a different one a different reference", () => {
    const first = buildDiscoveryQueries(REQUIREMENTS);
    const second = buildDiscoveryQueries(REQUIREMENTS);
    expect(first.map((query) => query.reference)).toEqual(second.map((query) => query.reference));
    expect(new Set(first.map((query) => query.reference)).size).toBe(first.length);
    // The reference is a uuid, so the ledger's own column holds it, and it is a
    // digest, so the shopper's words are not in the ledger.
    expect(first[0]?.reference).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe("SearXNG responses", () => {
  const query: DiscoveryQuery = {
    reference: "2f1c3b4d-5e6f-8a7b-9c0d-1e2f3a4b5c6d",
    text: "waterdicht fietshelm kopen nederland",
    language: "nl",
    from: ["A waterproof bike helmet"],
  };

  it("reads candidates with provider, query, and rank provenance", () => {
    const { candidates, rejected } = readSearxngResponse(SEARXNG_BIKE_HELMET_NL, query);

    expect(rejected).toBe(1);
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "https://www.fietshelmwinkel.nl/waterdichte-fietshelm-zwart",
      // The fragment is dropped: it is the same page, not a second candidate.
      "https://www.helmstore.nl/producten/fietshelm-regen",
    ]);
    expect(candidates[0]).toEqual({
      url: "https://www.fietshelmwinkel.nl/waterdichte-fietshelm-zwart",
      domain: "www.fietshelmwinkel.nl",
      title: {
        evidence: "unverified_claim",
        text: "Waterdichte fietshelm zwart - Fietshelmwinkel",
      },
      snippet: {
        evidence: "unverified_claim",
        text: "Waterdichte fietshelm in het zwart, geleverd binnen 2 dagen.",
      },
      provenance: {
        provider: "searxng",
        query: {
          reference: "2f1c3b4d-5e6f-8a7b-9c0d-1e2f3a4b5c6d",
          text: "waterdicht fietshelm kopen nederland",
          language: "nl",
        },
        rank: 1,
      },
    });
  });

  it("rejects a result that is not an http page or has no title", () => {
    const { candidates, rejected } = readSearxngResponse(
      {
        results: [
          { url: "javascript:alert(1)", title: "Nope" },
          { url: "not a url", title: "Nope" },
          { url: "https://shop.example/product", title: "   " },
          { url: "https://shop.example/ok", title: "Fine" },
          "not an object",
        ],
      },
      query,
    );
    expect(candidates.map((candidate) => candidate.url)).toEqual(["https://shop.example/ok"]);
    expect(rejected).toBe(4);
  });

  it("keeps only the bounded number of results per search", () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      url: `https://shop.example/product-${index}`,
      title: `Product ${index}`,
    }));
    expect(
      readSearxngResponse({ results }, query, { maxResultsPerQuery: 3 }).candidates,
    ).toHaveLength(3);
  });

  it("rejects a malformed response instead of reporting an empty result", () => {
    expect(() => readSearxngResponse("not json", query)).toThrow(DiscoveryResponseError);
    expect(() => readSearxngResponse(null, query)).toThrow(DiscoveryResponseError);
    expect(() => readSearxngResponse({ results: "none" }, query)).toThrow(DiscoveryResponseError);
    expect(() => readSearxngResponse({ unresponsive: true }, query)).toThrow(
      DiscoveryResponseError,
    );
  });

  it("marks provider text as a claim, and drops text that is only whitespace", () => {
    expect(unverifiedClaim("  A helmet ")).toEqual({
      evidence: "unverified_claim",
      text: "A helmet",
    });
    expect(unverifiedClaim("   ")).toBeUndefined();
  });
});

describe("the SearXNG provider", () => {
  const query: DiscoveryQuery = {
    reference: "2f1c3b4d-5e6f-8a7b-9c0d-1e2f3a4b5c6d",
    text: "waterdicht fietshelm kopen nederland",
    language: "nl",
    from: ["A waterproof bike helmet"],
  };

  it("sends only the query, the format, and the language, and no credential", async () => {
    const recorded = recordedProvider({ [query.text]: SEARXNG_BIKE_HELMET_NL });
    const provider = createSearxngProvider({
      baseUrl: "http://searxng:8080",
      fetch: recorded.fetch,
    });

    const { candidates } = await provider.search(query);

    expect(candidates).toHaveLength(2);
    expect(recorded.sent).toHaveLength(1);
    const sent = recorded.sent[0];
    expect(sent?.url).toBe(
      "http://searxng:8080/search?q=waterdicht+fietshelm+kopen+nederland&format=json&language=nl-NL",
    );
    expect(sent?.accept).toBe("application/json");
  });

  it("resolves the endpoint against an instance mounted under a path", async () => {
    const recorded = recordedProvider({ [query.text]: SEARXNG_BIKE_HELMET_NL });
    await createSearxngProvider({
      baseUrl: "https://search.example/searxng",
      fetch: recorded.fetch,
    }).search(query);

    expect(recorded.sent[0]?.url).toContain("/searxng/search?");
  });

  it("answers explicitly when the instance does not answer", async () => {
    const refused = createSearxngProvider({
      baseUrl: "http://searxng:8080",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(refused.search(query)).rejects.toThrow(TypeError);

    const down = createSearxngProvider({
      baseUrl: "http://searxng:8080",
      fetch: (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(down.search(query)).rejects.toThrow(DiscoveryUnavailableError);
  });

  it("rejects a body that is not JSON", async () => {
    const provider = createSearxngProvider({
      baseUrl: "http://searxng:8080",
      fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(provider.search(query)).rejects.toThrow(DiscoveryResponseError);
  });
});

describe("discovery through the engine", () => {
  it("finds candidates, charges every search to the ledger, and keeps provenance", async () => {
    const recorded = recordedProvider({
      "waterproof bike helmet black kopen nederland": SEARXNG_BIKE_HELMET_NL,
      "buy waterproof bike helmet black netherlands": SEARXNG_BIKE_HELMET_EN,
    });
    const installation = await createInstallation({ fetch: recorded.fetch });
    const { engine, shopperId, conversationId } = installation;

    const run = await engine.research.start(shopperId, conversationId);
    const result = await engine.discovery.candidates(shopperId, run.id, conversationId);

    expect(result.outcome).toBe("ok");
    expect(result.calls).toBe(2);
    // The Dutch search found both pages, so the English one adds only what the
    // Dutch one did not: the same page is listed once, with the query that
    // ranked it.
    expect(result.candidates.map((candidate) => candidate.url)).toEqual([
      "https://www.fietshelmwinkel.nl/waterdichte-fietshelm-zwart",
      "https://www.helmstore.nl/producten/fietshelm-regen",
      "https://www.bikegear.eu/helmets/rain-commuter",
    ]);
    expect(result.candidates[1]?.provenance).toEqual({
      provider: "searxng",
      query: {
        reference: result.queries[0]?.reference,
        text: "waterproof bike helmet black kopen nederland",
        language: "nl",
      },
      rank: 2,
    });
    expect(result.candidates[2]?.provenance.query.language).toBe("en");

    // Every search is on the ledger as a retrieval call, settled, so nothing is
    // left in flight.
    const charged = await engine.research.get(shopperId, run.id);
    expect(charged.usage.calls).toBe(2);
    expect(charged.usage.reservedCents).toBe(0);
    const usage = await engine.research.usage({ id: await adminOf(installation) });
    expect(usage.calls.retrieval).toBe(2);

    // No outgoing query carries an account detail or a conversation message:
    // they are the product phrases alone.
    expect(recorded.sent).toHaveLength(2);
    for (const sent of recorded.sent) {
      expect(sent.text).not.toContain("shopper@example.com");
      expect(sent.text).not.toContain("Bike helmet");
    }
    await discard(installation);
  });

  it("never reads a snippet as a fact: every provider string is a claim", async () => {
    const recorded = recordedProvider({
      "waterproof bike helmet black kopen nederland": SEARXNG_BIKE_HELMET_NL,
      "buy waterproof bike helmet black netherlands": SEARXNG_BIKE_HELMET_EN,
    });
    const installation = await createInstallation({ fetch: recorded.fetch });
    const { engine, shopperId, conversationId } = installation;
    const run = await engine.research.start(shopperId, conversationId);

    const result = await engine.discovery.candidates(shopperId, run.id, conversationId);

    // "geleverd binnen 2 dagen" is exactly the kind of sentence a snippet uses
    // to promise delivery. It is carried as a claim, so nothing downstream can
    // read it as the delivery fact it appears to be.
    expect(result.candidates[0]?.snippet).toEqual({
      evidence: "unverified_claim",
      text: "Waterdichte fietshelm in het zwart, geleverd binnen 2 dagen.",
    });
    expect(result.candidates[0]?.title.evidence).toBe("unverified_claim");
    // A candidate is a page, a claim about it, and where it came from: there is
    // no field for a price, a suitability, or a delivery promise.
    expect(Object.keys(result.candidates[0] ?? {}).sort()).toEqual([
      "domain",
      "provenance",
      "snippet",
      "title",
      "url",
    ]);
    await discard(installation);
  });

  it("treats a malformed search URL as unconfigured instead of failing to start", async () => {
    const { schema, drop } = await createTestSchema(server);
    const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
    await migrate(database);
    // A bare host:port is the typo an operator is most likely to write; it must
    // read as "not configured", not crash the engine the way `new URL` would.
    const engine = createEngine({
      database,
      setupToken: "unused-in-these-tests",
      identity: createFakeIdentityStore(database),
      services: { discovery: { searxngUrl: "searxng:8080" } },
    });

    expect((await engine.setup.readiness()).discovery).toBe("unconfigured");
    await database.destroy();
    await drop();
  });

  it("says unconfigured rather than finding nothing when no instance is set", async () => {
    const { schema, drop } = await createTestSchema(server);
    const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
    await migrate(database);
    const engine = createEngine({
      database,
      setupToken: "unused-in-these-tests",
      identity: createFakeIdentityStore(database),
    });
    const shopperId = await createAccount(database, "shopper@example.com");
    const conversation = await engine.conversations.create(shopperId, { title: "Bike helmet" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "A waterproof bike helmet, black" }],
      preferences: [],
    });

    const run = await engine.research.start(shopperId, conversation.id);
    const result = await engine.discovery.candidates(shopperId, run.id, conversation.id);

    expect(result).toMatchObject({ outcome: "unconfigured", candidates: [], calls: 0 });
    // The queries it would have sent are still reported, so a screen can say
    // what discovery was about to do.
    expect(result.queries).toHaveLength(2);
    expect((await engine.research.get(shopperId, run.id)).usage.calls).toBe(0);
    await database.destroy();
    await drop();
  });

  it("says unavailable when the instance does not answer, and still charges the calls", async () => {
    const installation = await createInstallation({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch,
    });
    const { engine, shopperId, conversationId } = installation;

    const run = await engine.research.start(shopperId, conversationId);
    const result = await engine.discovery.candidates(shopperId, run.id, conversationId);

    expect(result.outcome).toBe("unavailable");
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "unavailable",
      "unavailable",
    ]);
    // Only the error's name is kept: a message can carry the instance's address.
    expect(result.attempts[0]?.detail).toBe("TypeError");
    // The searches were sent and failed: they are on the ledger, not free.
    expect((await engine.research.get(shopperId, run.id)).usage.calls).toBe(2);
    await discard(installation);
  });

  it("classifies empty results, inadequate results, and malformed responses apart", async () => {
    const empty = await discoverWith(recordedProvider({}).fetch);
    expect(empty.outcome).toBe("no_results");
    expect(empty.attempts.map((attempt) => attempt.outcome)).toEqual(["no_results", "no_results"]);

    const contactOnly = {
      results: [
        { url: "mailto:shop@example.com", title: "Contact" },
        { url: "https://shop.example/", title: "" },
      ],
    };
    const inadequate = await discoverWith(
      recordedProvider({
        "waterproof bike helmet black kopen nederland": contactOnly,
        "buy waterproof bike helmet black netherlands": contactOnly,
      }).fetch,
    );
    expect(inadequate.outcome).toBe("inadequate");

    const malformed = await discoverWith(
      (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    );
    expect(malformed.outcome).toBe("malformed");
    expect(malformed.attempts[0]?.detail).toContain("malformed");
  });

  it("stops at the run's call limit and reports what it could not search", async () => {
    const installation = await createInstallation({
      fetch: recordedProvider({
        "waterproof bike helmet black kopen nederland": SEARXNG_BIKE_HELMET_NL,
      }).fetch,
      researchCeilings: { callLimit: 1 },
    });
    const { engine, shopperId, conversationId } = installation;

    const run = await engine.research.start(shopperId, conversationId);
    const result = await engine.discovery.candidates(shopperId, run.id, conversationId);

    expect(result.calls).toBe(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.stopped).toEqual({ reason: "call_limit", queriesNotSent: 1 });
    // What the search found is kept: it was paid for.
    expect(result.candidates).toHaveLength(2);
    expect((await engine.research.get(shopperId, run.id)).state).toBe("paused");
    await discard(installation);
  });

  it("refuses a conversation that is not the shopper's before spending anything", async () => {
    const recorded = recordedProvider({});
    const installation = await createInstallation({ fetch: recorded.fetch });
    const { engine, shopperId, conversationId } = installation;
    const otherId = await createAccount(installation.database, "other@example.com");
    const run = await engine.research.start(shopperId, conversationId);

    await expect(engine.discovery.candidates(otherId, run.id, conversationId)).rejects.toThrow(
      ConversationNotFoundError,
    );
    expect(recorded.sent).toHaveLength(0);
    expect((await engine.research.get(shopperId, run.id)).usage.calls).toBe(0);
    await discard(installation);
  });
});

/** Runs one discovery over a fresh installation with the given transport. */
async function discoverWith(fetch: typeof globalThis.fetch) {
  const installation = await createInstallation({ fetch });
  const { engine, shopperId, conversationId } = installation;
  const run = await engine.research.start(shopperId, conversationId);
  const result = await engine.discovery.candidates(shopperId, run.id, conversationId);
  await discard(installation);
  return result;
}

/** The installation's admin, so usage can be read through the admin-only report. */
async function adminOf(installation: Installation): Promise<string> {
  const adminId = await createAccount(installation.database, "operator@example.com");
  await installation.database.transaction(async (transaction) => {
    await transaction("installation")
      .insert({ initial_admin_created_at: transaction.fn.now() })
      .onConflict("id")
      .ignore();
    await transaction("profiles").where({ id: adminId }).update({ role: "admin" });
  });
  return adminId;
}

/**
 * The optional bounded live check. It is skipped unless an operator points it at
 * a running instance, so the suite never reaches the internet by itself:
 *
 *   DISCOVERY_LIVE_SEARXNG_URL=http://127.0.0.1:8080 pnpm --filter \
 *     @shopping-assistant/engine test
 */
const liveUrl = process.env.DISCOVERY_LIVE_SEARXNG_URL;

describe.skipIf(!liveUrl)("a live SearXNG instance", () => {
  it("answers one bounded query with candidates and provenance", async () => {
    const query: DiscoveryQuery = {
      reference: "2f1c3b4d-5e6f-8a7b-9c0d-1e2f3a4b5c6d",
      text: "waterdicht fietshelm kopen nederland",
      language: "nl",
      from: ["A waterproof bike helmet"],
    };
    const provider = createSearxngProvider({
      baseUrl: liveUrl ?? "",
      bounds: { ...DEFAULT_DISCOVERY_BOUNDS, maxResultsPerQuery: 3 },
    });

    const { candidates } = await provider.search(query);

    expect(candidates.length).toBeLessThanOrEqual(3);
    for (const candidate of candidates) {
      expect(candidate.url.startsWith("http")).toBe(true);
      expect(candidate.provenance).toEqual({
        provider: "searxng",
        query: { reference: query.reference, text: query.text, language: "nl" },
        rank: expect.any(Number),
      });
    }
  });
});
