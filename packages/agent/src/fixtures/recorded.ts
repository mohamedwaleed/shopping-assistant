import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The request bodies the AI SDK produces, recorded from the SDK itself by
 * `scripts/record-requests.mjs`. Tests compare what a route actually sends with
 * these, so a change in the SDK's wire format is noticed here rather than by a
 * provider in production.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const recorded = JSON.parse(
  readFileSync(fileURLToPath(new URL("./recorded-requests.json", import.meta.url)), "utf8"),
) as Record<string, RecordedRequest[]>;

/** The requests a route makes, in order: the tool call, then the stream. */
export function recordedRequests(route: "openai" | "openai-compatible" | "openrouter"): {
  toolCall: RecordedRequest;
  stream: RecordedRequest;
} {
  const requests = recorded[route];
  if (!requests || requests.length < 2) throw new Error(`No recorded requests for ${route}`);
  const [toolCall, stream] = requests as [RecordedRequest, RecordedRequest];
  return { toolCall, stream };
}
