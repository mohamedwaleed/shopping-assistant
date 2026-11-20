// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { createSecretCipher, createShoppingCore, type Principal } from "../src/index";
import { BOL_TABLE_HTML, COOLBLUE_JSONLD_HTML, FIXTURE_RESOLVE, FIXTURE_SOURCE_POLICY, fixtureFetcher } from "./support/source-fixtures";

// The engine boundary: an admitted shopper reads a permitted source and an
// operator inspects what that source is worth. Authorization, adapter version,
// required-field coverage and access blocks are all proven here against real
// PostgreSQL, without touching a network.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const shopper: Principal = { kind: "workspace", userId: "sources-shopper", workspaceId: "sources-workspace", sessionId: "sources-session" };
const administrator: Principal = { ...shopper, kind: "administrator" };
const anonymous: Principal = { kind: "anonymous" };

const COOLBLUE_URL = "https://www.coolblue.nl/product/869952/dell-ultrasharp-u2723qe.html";
const BOL_URL = "https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/";

describe("source reliability through the core", () => {
  let db: Knex;
  let core: ReturnType<typeof createShoppingCore>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
    core = createShoppingCore({
      db,
      ingestion: {
        sourcePolicy: FIXTURE_SOURCE_POLICY,
        resolve: FIXTURE_RESOLVE,
        fetch: fixtureFetcher({
          [COOLBLUE_URL]: COOLBLUE_JSONLD_HTML,
          [BOL_URL]: BOL_TABLE_HTML,
        }),
      },
      models: {
        cipher: createSecretCipher({ key: "sources-test-installation-secret" }),
        probe: async () => {
          throw new Error("this seam never probes a model");
        },
      },
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("records the adapter version and required-field coverage of a real ingest", async () => {
    const ingested = await core.catalogue.ingestProductPage(shopper, COOLBLUE_URL);
    expect(ingested.ok).toBe(true);

    const coverage = await core.sources.coverage(administrator, "www.coolblue.nl");

    expect(coverage).toMatchObject({
      ok: true,
      value: {
        host: "www.coolblue.nl",
        adapter: { id: "coolblue", version: "2026.11.1" },
        coverage: "complete",
        coveredFields: ["name", "price", "currency", "gtin"],
        missingFields: [],
        extraction: "source-adapter",
        lastSuccessAt: expect.any(String),
        lastFailure: null,
      },
    });
    if (!coverage.ok) return;
    expect(coverage.value.retained.claimCount).toBeGreaterThan(0);
    expect(coverage.value.retained.evidenceId).toEqual(ingested.ok ? ingested.value.evidenceId : null);
  });

  it("reports a blocked source without recording an observation", async () => {
    const challenged = createShoppingCore({
      db,
      ingestion: {
        sourcePolicy: FIXTURE_SOURCE_POLICY,
        resolve: FIXTURE_RESOLVE,
        fetch: async () => new Response("<html><h1>Controleer of je een mens bent</h1></html>"),
      },
      models: {
        cipher: createSecretCipher({ key: "sources-test-installation-secret" }),
        probe: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(challenged.catalogue.ingestProductPage(shopper, BOL_URL)).resolves.toMatchObject({
      ok: false,
      error: { kind: "source-fetch-failed", classification: "challenge" },
    });

    const coverage = await challenged.sources.coverage(administrator, "www.bol.com");
    expect(coverage).toMatchObject({
      ok: true,
      value: { coverage: "none", lastSuccessAt: null, lastFailure: { kind: "challenge" } },
    });
  });

  it("only an operator records a robots or terms restriction, and it stops further reads", async () => {
    // A workspace shopper may ingest, but declaring a source restricted is an
    // operator decision about the whole installation.
    expect(
      await core.sources.recordAccessBlock(shopper, { url: BOL_URL, reason: "terms", signal: "no-resale" }),
    ).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(
      await core.sources.recordAccessBlock(administrator, { url: "not-a-url", reason: "terms", signal: "x" }),
    ).toEqual({
      ok: false,
      error: { kind: "invalid-input", field: "url", message: "url must be an absolute URL" },
    });

    expect(await core.sources.recordAccessBlock(administrator, { url: BOL_URL, reason: "terms", signal: "no-resale" })).toMatchObject({
      ok: true,
    });

    const coverage = await core.sources.coverage(administrator, "www.bol.com");
    expect(coverage).toMatchObject({
      ok: true,
      value: { accessBlocks: [expect.objectContaining({ reason: "terms", signal: "no-resale" })] },
    });
  });

  it("keeps host coordination an operator setting within hard bounds", async () => {
    expect(await core.sources.coordination(shopper, "www.coolblue.nl")).toEqual({
      ok: false,
      error: { kind: "forbidden", capability: "installation.manage" },
    });
    expect(await core.sources.coordination(administrator, "www.coolblue.nl")).toEqual({
      ok: true,
      value: { maxConcurrent: 1, minimumIntervalMs: 1_000 },
    });
    expect(
      await core.sources.saveCoordination(administrator, "www.coolblue.nl", { maxConcurrent: 2, minimumIntervalMs: 250 }),
    ).toEqual({ ok: true, value: { maxConcurrent: 2, minimumIntervalMs: 250 } });
    expect(
      await core.sources.saveCoordination(administrator, "www.coolblue.nl", { maxConcurrent: 99, minimumIntervalMs: 0 }),
    ).toMatchObject({ ok: false, error: { field: "maxConcurrent" } });
  });

  it("lets any catalogue reader see coverage but rejects a malformed host", async () => {
    expect(await core.sources.coverage(anonymous, "www.coolblue.nl")).toMatchObject({ ok: true });
    expect(await core.sources.coverage(anonymous, "../etc/passwd")).toEqual({
      ok: false,
      error: { kind: "invalid-input", field: "host", message: "host must be a DNS hostname" },
    });
  });
});
