// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a single page retrieval is allowed to cost. These are starting values
 * to calibrate (docs/catalogue-design.md, "bounded fetching"), not promises
 * about how fast a retailer answers.
 */
export interface FetchBounds {
  /** Wall-clock limit for one request, including reading the body. */
  timeoutMs: number;
  /** Largest page body accepted; a bigger page is not an excerpt candidate. */
  maxBytes: number;
  /** Redirect hops followed after the first request. */
  maxRedirects: number;
}

export const DEFAULT_FETCH_BOUNDS: FetchBounds = {
  timeoutMs: 10_000,
  maxBytes: 5 * 1024 * 1024,
  maxRedirects: 3,
};

/** A request that never answers must not hold a research run open. */
export class FetchTimeout extends Error {
  constructor() {
    super("the source did not answer within the fetch timeout");
    this.name = "FetchTimeout";
  }
}

/** A body longer than the bound, discovered while reading or from its header. */
export class ResponseTooLarge extends Error {
  constructor() {
    super("the source page exceeds the size bound");
    this.name = "ResponseTooLarge";
  }
}

export function fetchBounds(overrides: Partial<FetchBounds> = {}): FetchBounds {
  return { ...DEFAULT_FETCH_BOUNDS, ...overrides };
}

/** Positive, finite whole number; anything else falls back to the default. */
export function boundedInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
