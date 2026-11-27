import { STREAMED_TEXT } from "./protocol.ts";
import type { CapturedRequest } from "./transport.ts";

/**
 * A transport for one conversation turn, answering the provider's streamed
 * requests in order. A turn that calls a tool makes two streamed requests —
 * one to obtain the tool call, one to continue after the tool result — so the
 * fixture serves one step per request rather than the same body every time.
 */

export type ConversationFixtureStep =
  | { kind: "tool-call"; tool: string; arguments: Record<string, unknown> }
  | { kind: "text"; frames?: unknown[] }
  | { kind: "status"; status: number; body: unknown }
  | { kind: "raw"; body: string };

/** One SSE frame of a Chat Completions stream, mirroring `protocol.ts`. */
export function frame(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1_800_000_000,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

/** A streamed answer that asks for one typed tool call, then ends. */
function toolCallStream(toolName: string, arguments_: Record<string, unknown>): unknown[] {
  return [
    frame({ role: "assistant", content: "" }),
    frame({
      tool_calls: [
        {
          index: 0,
          id: "call_fixture",
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(arguments_) },
        },
      ],
    }),
    frame({}, "tool_calls", {
      usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
    }),
  ];
}

function streamResponse(frames: unknown[]): Response {
  const body =
    frames.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function conversationFixtureTransport(steps: ConversationFixtureStep[]): {
  fetch: typeof globalThis.fetch;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  let served = 0;
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

    const index = Math.min(served, steps.length - 1);
    served += 1;
    const step = steps[index];
    if (!step) throw new Error("A conversation fixture ran out of steps");
    if (step.kind === "tool-call") {
      return streamResponse(toolCallStream(step.tool, step.arguments));
    }
    if (step.kind === "text") {
      return streamResponse(step.frames ?? STREAMED_TEXT);
    }
    if (step.kind === "raw") {
      return new Response(step.body, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, captured };
}

/** Every model payload the turn sent, so a test can inspect the context. */
export function modelPayloads(captured: CapturedRequest[]): Record<string, unknown>[] {
  return captured.map((request) => request.body);
}