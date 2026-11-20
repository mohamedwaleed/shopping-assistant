// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  boundedInteger,
  FetchTimeout,
  ResponseTooLarge,
  type FetchBounds,
} from "./bounds";

/**
 * Everything that decides *whether* a page may be retrieved and *what* came
 * back. Keeping it apart from parsing and persistence lets the unsafe-URL and
 * destination checks be exercised without any catalogue write.
 */

export interface PermittedSource {
  retailerName: string;
  baseUrl: string;
  /** Exact hostname or a subdomain suffix such as `.example.nl`. */
  hosts: readonly string[];
}

export type SourcePolicy = (url: URL) => PermittedSource | null;

/** Resolves every destination before a connection; injectable for tests. */
export type DestinationResolver = (hostname: string) => Promise<readonly string[]>;

export interface PageFetcher {
  (url: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

/**
 * How a retrieval ended. Only `"ok"` carries a body; every other value is a
 * named refusal that callers can show and count.
 */
export type FetchFailure =
  | "unsafe-url"
  | "not-permitted"
  | "network"
  | "timeout"
  | "size"
  | "redirect"
  | "http"
  | "challenge";

export type FetchOutcome =
  | {
      ok: true;
      /** The submitted URL, exactly as the caller wrote it. */
      sourceUrl: string;
      /** Where the redirect chain ended. */
      finalUrl: string;
      html: string;
      bytes: number;
      redirects: number;
    }
  | {
      ok: false;
      sourceUrl: string;
      failure: FetchFailure;
      /** The URL being retrieved when the refusal happened. */
      url: string;
      redirects: number;
      /** HTTP status when a response arrived; absent for local refusals. */
      status?: number;
    };

const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * A page that asks a human to prove they are one, or reports that access is
 * denied, is a block — even when it arrives with HTTP 200 and a plausible
 * product-shaped shell. These markers are deliberately about access gates,
 * not product vocabulary.
 */
const CHALLENGE_PATTERN =
  /captcha|recaptcha|hcaptcha|verify you are human|are you a robot|security checkpoint|checking your browser|access denied|attention required|unusual traffic|enable javascript and cookies to continue|controleer of je een mens bent|ben je een robot/i;

/**
 * Refuses a URL this installation must never request: anything but public
 * HTTPS, embedded credentials, loopback/link-local/private/special-use names.
 * This runs before any lookup or fetch so a refusal is provably local.
 */
function safeSourceUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (!publicHostname(url.hostname)) return null;
  return url;
}

/** Hostnames that can never name a public destination. */
function publicHostname(rawHostname: string): boolean {
  const hostname = rawHostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname) return false;
  if (BLOCKED_HOSTS.has(hostname)) return false;
  if (hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) return false;
  if (hostname.includes(":")) return ipv6IsPublic(hostname);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return ipv4IsPublic(hostname);
  return true;
}

/** The address a permitted host actually resolved to must also be public. */
function publicDestination(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return false;
  if (value.includes(":")) return ipv6IsPublic(value);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return ipv4IsPublic(value);
  return false;
}

function ipv4IsPublic(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function ipv6IsPublic(address: string): boolean {
  if (address === "::" || address === "::1") return false;
  // An IPv4-mapped address hides its real destination behind a v6 literal.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return ipv4IsPublic(mapped[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    return ipv4IsPublic(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (address.startsWith("fc") || address.startsWith("fd")) return false; // unique local
  if (/^fe[89ab]/.test(address)) return false; // link-local
  if (/^ff/.test(address)) return false; // multicast
  if (address.startsWith("64:ff9b")) return false; // NAT64
  if (address.startsWith("2001:db8")) return false; // documentation
  return true;
}

/** The policy names the source; the host must still belong to it. */
function permittedHost(url: URL, source: PermittedSource): boolean {
  return source.hosts.some((host) => {
    const candidate = host.trim().toLowerCase();
    if (candidate.startsWith(".")) return url.hostname.endsWith(candidate) && url.hostname.length > candidate.length;
    return url.hostname === candidate;
  });
}

export interface RetrieveDependencies {
  fetch: PageFetcher;
  resolve: DestinationResolver;
  policy: SourcePolicy;
  bounds: FetchBounds;
}

function parseContentLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (!header) return null;
  const value = Number(header);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads the body under the size bound, cancelling the stream when it overruns. */
async function readBounded(response: Response, maxBytes: number): Promise<{ html: string; bytes: number }> {
  // A declared length over the bound is refused before any body is read.
  const declared = parseContentLength(response);
  if (declared !== null && declared > maxBytes) throw new ResponseTooLarge();
  if (!response.body) {
    const html = await response.text();
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes > maxBytes) throw new ResponseTooLarge();
    return { html, bytes };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { html: Buffer.concat(chunks).toString("utf8"), bytes };
}

/**
 * Retrieves one page inside the bounds, re-validating policy and network
 * destination on every hop. A failure is reported, never retried, and never
 * turned into a partial page: callers must not persist a refusal.
 */
export async function retrievePage(
  sourceUrl: string,
  deps: RetrieveDependencies,
): Promise<FetchOutcome> {
  const initial = safeSourceUrl(sourceUrl);
  if (!initial) return { ok: false, sourceUrl, failure: "unsafe-url", url: sourceUrl, redirects: 0 };
  const source = deps.policy(initial);
  if (!source || !permittedHost(initial, source)) {
    return { ok: false, sourceUrl, failure: "not-permitted", url: initial.toString(), redirects: 0 };
  }

  const maxRedirects = boundedInteger(deps.bounds.maxRedirects, 3);
  const maxBytes = boundedInteger(deps.bounds.maxBytes, 5 * 1024 * 1024);
  const timeoutMs = boundedInteger(deps.bounds.timeoutMs, 10_000);
  let current = initial;

  for (let redirects = 0; ; redirects += 1) {
    try {
      const destinations = await deps.resolve(current.hostname);
      if (!destinations.length || !destinations.every(publicDestination)) {
        return { ok: false, sourceUrl, failure: "unsafe-url", url: current.toString(), redirects };
      }
    } catch {
      return { ok: false, sourceUrl, failure: "network", url: current.toString(), redirects };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The fetcher rejects as soon as the signal fires, which can settle first;
    // the flag keeps that race from being reported as a plain network failure.
    let expiredFlag = false;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expiredFlag = true;
        controller.abort();
        reject(new FetchTimeout());
      }, timeoutMs);
    });

    let response: Response;
    try {
      const request = Promise.resolve(deps.fetch(current.toString(), { signal: controller.signal }));
      response = await Promise.race([request, expired]);
    } catch (error) {
      if (expiredFlag || error instanceof FetchTimeout) return { ok: false, sourceUrl, failure: "timeout", url: current.toString(), redirects };
      return { ok: false, sourceUrl, failure: "network", url: current.toString(), redirects };
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      const next = location ? safeSourceUrl(new URL(location, current).toString()) : null;
      // A missing/unsafe Location, a chain past the limit, or a hop outside the
      // permitted source all end retrieval; the refused destination is named.
      if (!next || redirects >= maxRedirects || !permittedHost(next, source)) {
        return { ok: false, sourceUrl, failure: "redirect", url: (next ?? current).toString(), redirects: redirects + 1, status: response.status };
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      return { ok: false, sourceUrl, failure: "http", url: current.toString(), redirects, status: response.status };
    }

    let body: { html: string; bytes: number };
    try {
      body = await Promise.race([readBounded(response, maxBytes), expired]);
    } catch (error) {
      if (error instanceof ResponseTooLarge) return { ok: false, sourceUrl, failure: "size", url: current.toString(), redirects, status: response.status };
      if (error instanceof FetchTimeout || controller.signal.aborted) return { ok: false, sourceUrl, failure: "timeout", url: current.toString(), redirects, status: response.status };
      return { ok: false, sourceUrl, failure: "network", url: current.toString(), redirects, status: response.status };
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (CHALLENGE_PATTERN.test(body.html)) {
      return { ok: false, sourceUrl, failure: "challenge", url: current.toString(), redirects, status: response.status };
    }

    return {
      ok: true,
      sourceUrl,
      finalUrl: current.toString(),
      html: body.html,
      bytes: body.bytes,
      redirects,
    };
  }
}

export { FetchTimeout, ResponseTooLarge };
