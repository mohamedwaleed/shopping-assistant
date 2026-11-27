import { lookup as lookupAddresses } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  DEFAULT_PERMITTED_PORTS,
  judgeAddresses,
  judgeUrl,
  type DestinationRefusal,
} from "./destination.ts";
import { charsetOf, decodeText, readBounded, ResponseTooLargeError } from "./body.ts";

/**
 * The bounds a fetch works within. Every one of them is a hard stop, not a
 * preference: a retailer page that cannot be read inside them is reported as
 * such rather than allowed to take more.
 */
export interface FetchBounds {
  /** How long the whole retrieval may take, redirects included. */
  timeoutMs: number;
  /** How many redirects are followed before the chain is refused. */
  maxRedirects: number;
  /** How many bytes of a response body are read. */
  maxResponseBytes: number;
  /**
   * The ports a URL may name. It exists so an installation can be tested
   * against a server on an ephemeral port; a deployment keeps the default, and
   * a ceiling can only take a port away, never add one.
   */
  permittedPorts: readonly number[];
}

/** The application's own bounds, which the operator may only narrow. */
export const DEFAULT_FETCH_BOUNDS: FetchBounds = {
  timeoutMs: 10_000,
  maxRedirects: 4,
  maxResponseBytes: 2 * 1024 * 1024,
  permittedPorts: DEFAULT_PERMITTED_PORTS,
};

/**
 * Why a retrieval did not produce a response to classify.
 *
 * `refused` covers everything the installation itself declined to do: a scheme,
 * a destination, a port, or a redirect it will not follow. It is kept apart
 * from `failed` so a shopper is never told a shop was unreachable when the
 * truth is that we did not ask.
 */
export type FetchFailure =
  | { kind: "invalid_url" }
  | { kind: "refused"; refusal: DestinationRefusal }
  | { kind: "too_many_redirects"; limit: number }
  | { kind: "too_large"; bytes: number; limit: number }
  | { kind: "timeout"; limitMs: number }
  | { kind: "failed"; detail: string };

export interface FetchedPage {
  /** Where the body actually came from, after every redirect. */
  url: string;
  /** Every URL the chain passed through, in order, starting with the requested one. */
  chain: string[];
  status: number;
  /** The `Content-Type` without parameters, in lower case. */
  mediaType: string | undefined;
  /** The charset the response declared, for decoding its body. */
  charset: string | undefined;
  bytes: Uint8Array;
  /** How long the retrieval took, which is what the ledger is settled with. */
  durationMs: number;
}

export type FetchOutcome =
  | { ok: true; page: FetchedPage }
  | { ok: false; failure: FetchFailure; durationMs: number; url: string | undefined };

/**
 * Resolves a hostname to addresses, so the check is made on what the socket
 * will actually reach rather than on what the URL says.
 */
export type AddressResolver = (hostname: string) => Promise<string[]>;

export const systemResolver: AddressResolver = async (hostname) => {
  const answers = await lookupAddresses(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

export interface FetchOptions {
  bounds: FetchBounds;
  resolve?: AddressResolver;
  /**
   * Addresses that are judged safe despite being private. It is empty in a
   * deployment and exists so the test suite can point a public name at the
   * loopback server it controls; it is deliberately not part of `FetchBounds`,
   * so no configuration and no operator ceiling can widen the address rule.
   */
  permittedAddresses?: readonly string[];
}

/**
 * The `lookup` node's own HTTP client uses to open a connection. It answers
 * only with the address that was already judged safe.
 *
 * This closes the window between "we resolved this name and it was public" and
 * "the connection resolved it again and it was not": a name whose answer
 * changes between the check and the connect — DNS rebinding — would otherwise
 * reach a private address after passing the check. Handing back the checked
 * address means the connection can only go where the check said.
 */
export function pinnedLookup(addresses: readonly string[]) {
  return (
    _hostname: string,
    options: { all?: boolean; family?: number },
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    const [first] = addresses;
    if (first === undefined) {
      const error = new Error("no address to connect to") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    const family = first.includes(":") ? 6 : 4;
    if (options.all === true) {
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
      return;
    }
    callback(null, first, family);
  };
}

/** One response, with its body still to be read under the size cap. */
interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * One GET, with the connection pinned to an address that was judged safe.
 *
 * A redirect is deliberately not followed here: node's client follows one only
 * if asked, and asking would skip the re-validation each hop needs.
 */
async function request(
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
): Promise<RawResponse> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<RawResponse>((resolve, reject) => {
    const request: ClientRequest = transport.request(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(addresses) as never,
        signal,
        headers: {
          // Identify the installation honestly. A shop that does not want this
          // client is entitled to say so, and we do not disguise the request.
          "user-agent":
            "shopping-assistant/1.0 (page extraction; honours robots, logins, and paywalls)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
          "accept-language": "en;q=0.8",
          // A compressed body is decompressed by the client, so the size cap
          // must see the decompressed bytes; asking for none keeps the cap
          // honest.
          "accept-encoding": "identity",
        },
      },
      (response: IncomingMessage) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The `Content-Type` without its parameters, in lower case. */
export function mediaTypeOf(contentType: string | undefined): string | undefined {
  return contentType?.split(";")[0]?.trim().toLowerCase();
}

/** Whether a status is a redirect this client will follow. */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Whether a media type is a document this installation can parse. */
export function isHtml(mediaType: string | undefined): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

/**
 * Fetches one URL under every bound, following redirects one at a time and
 * judging each hop before it is requested.
 *
 * Nothing about a response body influences which URL is requested next: only
 * the `Location` header of a redirect does, and that is a URL, judged like any
 * other. A page that says "fetch this instead" in its text is quoted, never
 * obeyed.
 */
export async function fetchPage(
  rawUrl: string,
  { bounds, resolve = systemResolver, permittedAddresses = [] }: FetchOptions,
): Promise<FetchOutcome> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const fail = (failure: FetchFailure, url?: string): FetchOutcome => ({
    ok: false,
    failure,
    durationMs: elapsed(),
    url,
  });

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return fail({ kind: "invalid_url" });
  }
  // The deadline covers the whole retrieval, redirects included: a chain of
  // slow hops is one slow fetch, not several fast ones.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), bounds.timeoutMs);
  const chain: string[] = [];

  try {
    for (let hop = 0; ; hop += 1) {
      const judged = judgeUrl(current, bounds.permittedPorts);
      if (judged) return fail({ kind: "refused", refusal: judged }, current.toString());

      const host = current.hostname;
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch {
        return fail({ kind: "failed", detail: "name did not resolve" }, current.toString());
      }
      // A name with no answer is not a name this installation can vouch for.
      if (addresses.length === 0) {
        return fail({ kind: "failed", detail: "name did not resolve" }, current.toString());
      }
      // One blocked answer refuses the whole fetch: the connection could take
      // it, and there is no way to know which answer the socket will use. An
      // answer a test has explicitly permitted is not judged at all.
      const byAddress = judgeAddresses(
        addresses.filter((address) => !permittedAddresses.includes(address)),
      );
      if (byAddress) return fail({ kind: "refused", refusal: byAddress }, current.toString());

      chain.push(current.toString());
      let response: RawResponse;
      try {
        response = await request(current, addresses, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          return fail({ kind: "timeout", limitMs: bounds.timeoutMs }, current.toString());
        }
        const code = (error as NodeJS.ErrnoException).code;
        return fail(
          { kind: "failed", detail: code === undefined ? "connection failed" : code },
          current.toString(),
        );
      }

      if (isRedirect(response.status)) {
        // The redirect body is discarded rather than read: it is not evidence,
        // and reading it would spend the size cap on something unusable.
        await response.body?.cancel().catch(() => undefined);
        const location = headerOf(response.headers, "location");
        if (location === undefined) {
          return fail({ kind: "failed", detail: "redirect without a location" }, current.toString());
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return fail({ kind: "failed", detail: "redirect to an invalid location" }, current.toString());
        }
        // The limit is checked before the next hop is requested, so a refusal
        // costs no request at all.
        if (hop + 1 > bounds.maxRedirects) {
          return fail({ kind: "too_many_redirects", limit: bounds.maxRedirects }, next.toString());
        }
        current = next;
        continue;
      }

      const contentType = headerOf(response.headers, "content-type");
      const mediaType = mediaTypeOf(contentType);
      // A body that is not HTML is never read: a PDF or a video would spend the
      // whole size cap and still be unsupported.
      if (!isHtml(mediaType)) {
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: true,
          page: {
            url: current.toString(),
            chain,
            status: response.status,
            mediaType,
            charset: undefined,
            bytes: new Uint8Array(),
            durationMs: elapsed(),
          },
        };
      }

      // A declared length above the cap is refused before any of it is read;
      // the cap is still enforced while reading, because a length can lie.
      const declared = Number(headerOf(response.headers, "content-length"));
      if (Number.isFinite(declared) && declared > bounds.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        return fail(
          { kind: "too_large", bytes: declared, limit: bounds.maxResponseBytes },
          current.toString(),
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = await readBounded(response.body, {
          capBytes: bounds.maxResponseBytes,
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof ResponseTooLargeError) {
          return fail(
            { kind: "too_large", bytes: error.bytesRead, limit: error.capBytes },
            current.toString(),
          );
        }
        if (controller.signal.aborted) {
          return fail({ kind: "timeout", limitMs: bounds.timeoutMs }, current.toString());
        }
        return fail({ kind: "failed", detail: "body could not be read" }, current.toString());
      }

      return {
        ok: true,
        page: {
          url: current.toString(),
          chain,
          status: response.status,
          mediaType,
          charset: charsetOf(contentType),
          bytes,
          durationMs: elapsed(),
        },
      };
    }
  } finally {
    clearTimeout(timer);
    // Aborting a finished request is a no-op, and it releases a socket left
    // open by a read that stopped early.
    controller.abort(new Error("finished"));
  }
}

/** The text of a fetched HTML page, decoded by its own declared charset. */
export function pageText(page: FetchedPage): string {
  return decodeText(page.bytes, page.charset);
}
