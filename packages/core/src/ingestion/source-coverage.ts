// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";
import type { ResolvedModel } from "../models/types";
import {
  adapterFor,
  REQUIRED_PRODUCT_FIELDS,
  type AdapterReading,
  type RequiredProductField,
} from "./source-adapters";
import {
  readableContent,
  verifyModelReading,
  extractionPrompt,
  EXTRACTION_OUTPUT_TOKENS,
  type ModelExtractor,
} from "./readable-extraction";
import { DEFAULT_CACHE_TTL_MS, type AccessBlock, type CacheContext, type SourceReader } from "./source-reader";

/**
 * Source coverage (ticket 15).
 *
 * Coverage answers a question an operator actually asks: *can this source still
 * be read, what did we last get from it, and what is missing?* It is recorded
 * per host so a page is not the only unit of reliability, and it deliberately
 * separates two timestamps:
 *
 * - when a page was fetched, and when that fetch may be reused;
 * - when the source was last read successfully, and when it last failed.
 *
 * A layout change lowers coverage and records a failure; it never deletes the
 * observations, claims or price history a good read already produced.
 */

/** Bump when a change alters what a reading means, to isolate cached pages. */
export const EXTRACTION_REVISION = "2026-11-19.1";

export type CoverageState = "complete" | "partial" | "none";

export interface SourceCoverage {
  host: string;
  adapter: { id: string; version: string } | null;
  requiredFields: readonly RequiredProductField[];
  /** Required fields the latest reading found. */
  coveredFields: RequiredProductField[];
  missingFields: RequiredProductField[];
  coverage: CoverageState;
  /** How the latest reading was produced. */
  extraction: "structured-data" | "source-adapter" | "model" | "none";
  lastSuccessAt: string | null;
  lastFailure: { at: string; kind: string } | null;
  cache: {
    /** When the page was fetched, if it was fetched (not replayed). */
    fetchedAt: string | null;
    /** When the source's own caching says the page is stale. */
    sourceCacheExpiresAt: string | null;
    /** When this installation may reuse the recorded page. */
    reuseExpiresAt: string | null;
  };
  accessBlocks: AccessBlock[];
  /** Evidence the last good read produced, so a layout change is visible. */
  retained: { evidenceId: string | null; claimCount: number; observedAt: string | null };
}

export type ExtractionSource = "structured-data" | "source-adapter" | "model";

export interface ExtractionResult {
  reading: AdapterReading;
  source: ExtractionSource;
  /** The maintained adapter that produced it, when one did. */
  adapter: { id: string; version: string } | null;
  /** True when a required field is missing and nothing was recorded. */
  refused: boolean;
}

export interface SourceCoverageDependencies {
  db: Knex;
  reader: SourceReader;
  /**
   * The extraction model, supplied by the web adapter. When absent, a page with
   * no structured data and no maintained adapter is not extracted at all
   * rather than guessed at.
   */
  extractor?: ModelExtractor;
  /**
   * The installation's extraction model. Catalogue reading belongs to no
   * workspace, so it uses the installation configuration only.
   */
  resolveExtractionModel?: () => Promise<Result<ResolvedModel>>;
  now?: () => Date;
}

export interface SourceCoverageService {
  /** Coverage for a host, as last recorded. */
  read(principal: Principal, host: string): Promise<Result<SourceCoverage>>;
  /** Record a page the core has just persisted from a structured reading. */
  recordReading(input: {
    url: string;
    host: string;
    adapter: { id: string; version: string } | null;
    source: ExtractionSource;
    reading: AdapterReading;
    evidenceId: string;
    observedAt: Date;
  }): Promise<void>;
  /** Record a failed read without touching any earlier success. */
  recordFailure(input: { url: string; host: string; kind: string }): Promise<void>;
  /**
   * Extract a page: maintained adapter first, then readable content plus the
   * model. Never invents a required field; a missing one is reported.
   */
  extract(input: { url: string; html: string }): Promise<ExtractionResult>;
  /** The cache context every read for this installation uses. */
  cacheContext(): CacheContext;
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function createSourceCoverage(deps: SourceCoverageDependencies): SourceCoverageService {
  const { db, reader } = deps;
  const now = deps.now ?? (() => new Date());

  function cacheContext(): CacheContext {
    return { scope: "public-catalogue", revision: EXTRACTION_REVISION };
  }

  async function recordReading(input: Parameters<SourceCoverageService["recordReading"]>[0]): Promise<void> {
    const { reading } = input;
    const coverage: CoverageState =
      reading.requiredCoverage.missing.length === 0
        ? "complete"
        : reading.requiredCoverage.present.length > 0
          ? "partial"
          : "none";
    const adapterId = input.adapter?.id ?? input.source;
    const adapterVersion = input.adapter?.version ?? EXTRACTION_REVISION;
    // The reading's own coverage and the evidence it produced are what a later
    // failure must not overwrite, so they are written in one statement with the
    // success it belongs to.
    await db("source_adapter_state")
      .insert({
        host: input.host,
        adapter_id: adapterId,
        adapter_version: adapterVersion,
        required_fields: JSON.stringify(reading.requiredCoverage),
        field_coverage: coverage,
        last_success_at: input.observedAt,
        last_failure_at: null,
        last_failure_kind: null,
        cache_expires_at: new Date(input.observedAt.getTime() + DEFAULT_CACHE_TTL_MS),
        updated_at: now(),
      })
      .onConflict("host")
      .merge([
        "adapter_id",
        "adapter_version",
        "required_fields",
        "field_coverage",
        "last_success_at",
        "last_failure_at",
        "last_failure_kind",
        "cache_expires_at",
        "updated_at",
      ]);
    await db("source_requests").where({ url: input.url }).update({
      adapter_id: adapterId,
      adapter_version: adapterVersion,
    });
  }

  async function recordFailure(input: { url: string; host: string; kind: string }): Promise<void> {
    const adapter = adapterFor(new URL(input.url));
    await db("source_adapter_state")
      .insert({
        host: input.host,
        adapter_id: adapter?.id ?? "generic",
        adapter_version: adapter?.version ?? EXTRACTION_REVISION,
        required_fields: JSON.stringify([...REQUIRED_PRODUCT_FIELDS]),
        field_coverage: "none",
        last_failure_at: now(),
        last_failure_kind: input.kind,
        updated_at: now(),
      })
      .onConflict("host")
      .merge(["last_failure_at", "last_failure_kind", "updated_at"]);
  }

  async function read(principal: Principal, host: string): Promise<Result<SourceCoverage>> {
    if (!isAuthorized(principal, "catalogue.read")) {
      return err({ kind: "forbidden", capability: "catalogue.read" });
    }
    if (!HOST_PATTERN.test(host)) {
      return err({ kind: "invalid-input", field: "host", message: "host must be a DNS hostname" });
    }
    const state = await db("source_adapter_state").where({ host }).first();
    const blocks = await reader.blocks(host);
    if (!state) {
      return ok({
        host,
        adapter: null,
        requiredFields: REQUIRED_PRODUCT_FIELDS,
        coveredFields: [],
        missingFields: [...REQUIRED_PRODUCT_FIELDS],
        coverage: "none",
        extraction: "none",
        lastSuccessAt: null,
        lastFailure: null,
        cache: { fetchedAt: null, sourceCacheExpiresAt: null, reuseExpiresAt: null },
        accessBlocks: blocks,
        retained: { evidenceId: null, claimCount: 0, observedAt: null },
      });
    }

    const coverage = state.field_coverage as CoverageState;
    const stored = state.required_fields as
      | RequiredProductField[]
      | { present: RequiredProductField[]; missing: RequiredProductField[] };
    const present = Array.isArray(stored) ? [] : (stored.present ?? []);
    const missing = Array.isArray(stored) ? [...REQUIRED_PRODUCT_FIELDS] : (stored.missing ?? []);
    const adapterId = String(state.adapter_id);
    const extraction: SourceCoverage["extraction"] =
      adapterId === "structured-data" || adapterId === "model"
        ? adapterId
        : adapterId === "generic"
          ? "none"
          : "source-adapter";

    const lastRequest = await db("source_requests")
      .where({ host })
      .whereNotNull("fetched_at")
      .orderBy("fetched_at", "desc")
      .first();
    const retained = await db("source_evidence")
      .whereRaw("split_part(regexp_replace(source_url, '^[a-z]+://', ''), '/', 1) = ?", [host])
      .orderBy("observed_at", "desc")
      .first();
    const claimCount = retained
      ? Number((await db("source_claims").where({ evidence_id: retained.id }).count<{ count: string }>("id as count").first())?.count ?? 0)
      : 0;

    return ok({
      host,
      adapter:
        extraction === "source-adapter" || extraction === "structured-data"
          ? { id: adapterId, version: String(state.adapter_version) }
          : null,
      requiredFields: Array.isArray(stored) ? [...REQUIRED_PRODUCT_FIELDS] : REQUIRED_PRODUCT_FIELDS,
      coveredFields: present,
      missingFields: missing,
      coverage,
      extraction,
      lastSuccessAt: state.last_success_at ? new Date(state.last_success_at).toISOString() : null,
      lastFailure: state.last_failure_at
        ? { at: new Date(state.last_failure_at).toISOString(), kind: String(state.last_failure_kind) }
        : null,
      cache: {
        fetchedAt: lastRequest ? new Date(lastRequest.fetched_at).toISOString() : null,
        sourceCacheExpiresAt:
          lastRequest && lastRequest.expires_at
            ? new Date(lastRequest.expires_at).toISOString()
            : state.cache_expires_at
              ? new Date(state.cache_expires_at).toISOString()
              : null,
        reuseExpiresAt: lastRequest?.expires_at ? new Date(lastRequest.expires_at).toISOString() : null,
      },
      accessBlocks: blocks,
      retained: {
        evidenceId: retained?.id ?? null,
        claimCount,
        observedAt: retained?.observed_at ? new Date(retained.observed_at).toISOString() : null,
      },
    });
  }

  /**
   * A maintained adapter is authoritative for its host: if it cannot find a
   * required field, the model is not asked to fill the gap.
   */
  async function extract(input: { url: string; html: string }): Promise<ExtractionResult> {
    const url = new URL(input.url);
    const adapter = adapterFor(url);
    if (adapter) {
      const reading = adapter.read({ url: input.url, html: input.html });
      return {
        reading,
        source: "source-adapter",
        adapter: { id: adapter.id, version: adapter.version },
        refused: reading.requiredCoverage.missing.length > 0,
      };
    }

    const content = readableContent(input.html);
    if (content.empty || !deps.extractor || !deps.resolveExtractionModel) {
      const reading: AdapterReading = {
        fields: {},
        attributes: {},
        evidence: [],
        requiredCoverage: { present: [], missing: [...REQUIRED_PRODUCT_FIELDS] },
      };
      return { reading, source: "model", adapter: null, refused: true };
    }

    // A provider that is unconfigured or unreachable yields no reading; the
    // page is not blamed for it, and no field is filled in from elsewhere.
    const model = await deps.resolveExtractionModel();
    if (!model.ok) {
      const reading: AdapterReading = {
        fields: {},
        attributes: {},
        evidence: [],
        requiredCoverage: { present: [], missing: [...REQUIRED_PRODUCT_FIELDS] },
      };
      return { reading, source: "model", adapter: null, refused: true };
    }

    const answer = await deps.extractor({
      content,
      sourceUrl: input.url,
      maxOutputTokens: EXTRACTION_OUTPUT_TOKENS,
      prompt: extractionPrompt(content, input.url),
      model: model.value,
    });
    if (!answer) {
      const reading: AdapterReading = {
        fields: {},
        attributes: {},
        evidence: [],
        requiredCoverage: { present: [], missing: [...REQUIRED_PRODUCT_FIELDS] },
      };
      return { reading, source: "model", adapter: null, refused: true };
    }
    const verified = verifyModelReading(answer, content);
    return {
      reading: { ...verified, evidence: verified.evidence },
      source: "model",
      adapter: null,
      refused: verified.requiredCoverage.missing.length > 0,
    };
  }

  return { read, recordReading, recordFailure, extract, cacheContext };
}
