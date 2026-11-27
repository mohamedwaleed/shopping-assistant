/**
 * Reading a response body under a size cap. The cap is enforced as the bytes
 * arrive, not from `Content-Length`: a chunked response has no length to trust,
 * and one that lies would otherwise let a page consume the installation's
 * memory before any check ran.
 */

/** A response body larger than the cap, with how much was read before giving up. */
export class ResponseTooLargeError extends Error {
  readonly bytesRead: number;
  readonly capBytes: number;
  constructor(bytesRead: number, capBytes: number) {
    super(`The response body passed ${capBytes} bytes`);
    this.name = "ResponseTooLargeError";
    this.bytesRead = bytesRead;
    this.capBytes = capBytes;
  }
}

export interface ReadBoundedOptions {
  capBytes: number;
  /** Ends the read when the response stalls or the overall deadline passes. */
  signal: AbortSignal;
}

/**
 * Reads a web stream to the end under a byte cap. The stream is cancelled as
 * soon as the cap is passed, so an oversized body stops being downloaded rather
 * than being read and then rejected.
 *
 * Each read is raced against the abort signal, because cancelling a reader is
 * not enough on its own: a body that has stalled with a read in flight does not
 * settle until the socket does, and the deadline must be the deadline.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  { capBytes, signal }: ReadBoundedOptions,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort = () => undefined as void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // The reader is cancelled rather than only ignored: the connection is
      // the resource being protected. The cancel is not awaited, because
      // cancelling settles the pending read with `done: true`, and that must
      // not be mistaken for the body having ended.
      void reader.cancel().catch(() => undefined);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
  });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal.aborted) onAbort();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      // A cancelled stream can report itself finished rather than failing, so
      // an abort that arrives while a read is in flight is caught here: a body
      // cut short is not a body that ended.
      if (signal.aborted) throw signal.reason;
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(total, capBytes);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/**
 * Decodes bytes as text using the response's own declared charset. A page in a
 * legacy encoding is common enough that assuming UTF-8 would mangle every price
 * and title on it, while an unknown label falls back to UTF-8 rather than
 * failing the fetch.
 */
export function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** The charset a `Content-Type` header declares, if any. */
export function charsetOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return match?.[1];
}
