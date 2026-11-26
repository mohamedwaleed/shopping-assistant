import {
  HTML_RESPONSE,
  STREAMED_TEXT,
  TOOL_CALL_RESPONSE,
  TOOL_CALL_WRONG_TYPES,
  TOOL_NOT_CALLED_RESPONSE,
  UNSTREAMED_TEXT,
  errorResponse,
} from "./protocol.ts";

/** What a fixture server answers with, per request kind. */
export type ProviderBehaviour = {
  /** Frames of the streaming answer, a refusal, or a body that is not a stream. */
  stream:
    | { frames: unknown[] }
    | { status: number; body: unknown }
    | { raw: string };
  /** The body of the non-streaming answer. */
  toolCall: { status?: number; body: unknown } | { raw: string };
};

export const wellBehaved: ProviderBehaviour = {
  stream: { frames: STREAMED_TEXT },
  toolCall: { body: TOOL_CALL_RESPONSE },
};

export const notStreaming: ProviderBehaviour = {
  stream: { frames: UNSTREAMED_TEXT },
  toolCall: { body: TOOL_CALL_RESPONSE },
};

export const toolIgnored: ProviderBehaviour = {
  stream: { frames: STREAMED_TEXT },
  toolCall: { body: TOOL_NOT_CALLED_RESPONSE },
};

export const toolMisTyped: ProviderBehaviour = {
  stream: { frames: STREAMED_TEXT },
  toolCall: { body: TOOL_CALL_WRONG_TYPES },
};

export const credentialRejected: ProviderBehaviour = {
  stream: { status: 401, body: errorResponse("Incorrect API key provided: sk-fixture") },
  toolCall: { status: 401, body: errorResponse("Incorrect API key provided: sk-fixture") },
};

export const rateLimited: ProviderBehaviour = {
  stream: { status: 429, body: errorResponse("Rate limit reached") },
  toolCall: { status: 429, body: errorResponse("Rate limit reached") },
};

export const unknownModel: ProviderBehaviour = {
  stream: { status: 404, body: errorResponse("The model `nope` does not exist") },
  toolCall: { status: 404, body: errorResponse("The model `nope` does not exist") },
};

export const wrongProtocol: ProviderBehaviour = {
  stream: { raw: HTML_RESPONSE },
  toolCall: { raw: HTML_RESPONSE },
};

/** One request a fixture server received. */
export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A transport that answers from fixtures instead of the network, and records
 * what it was asked. It is passed to the provider as `fetch`, so the SDK's own
 * request building and stream parsing run exactly as they would against a real
 * endpoint.
 */
export function fixtureTransport(behaviour: ProviderBehaviour): {
  fetch: typeof globalThis.fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    captured.push({
      url,
      method: init?.method ?? "POST",
      headers: Object.fromEntries(headers.entries()),
      body,
    });

    const answer = body.stream === true ? behaviour.stream : behaviour.toolCall;
    if ("raw" in answer) {
      return new Response(answer.raw, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if ("status" in answer && answer.status !== undefined) {
      return jsonResponse(answer.status, answer.body);
    }
    if ("frames" in answer) {
      const frames = answer.frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join("");
      return new Response(`${frames}data: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return jsonResponse(200, answer.body);
  };
  return { fetch: fetch as typeof globalThis.fetch, captured };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
