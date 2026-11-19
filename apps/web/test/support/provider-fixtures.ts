// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Deterministic provider fixtures: a loopback HTTP server that speaks the wire
 * protocols the pinned Vercel AI SDK providers emit, so capability checks run
 * without network access or real API keys.
 *
 * - OpenAI: `POST /openai/v1/responses` and `/openai/v1/chat/completions`
 * - Anthropic: `POST /anthropic/v1/messages`
 * - OpenAI-compatible (local models): `POST /compatible/v1/chat/completions`
 *
 * Behaviour is selected by the model id, so a test can ask for a model that
 * streams, one that ignores tools, or one that rejects every request.
 */
export type FixtureMode =
  | "complete"
  | "no-tools"
  /** Answers prose, like an endpoint with no structured-output support. */
  | "no-structured-output"
  /** Answers valid JSON of another shape, ignoring the requested schema. */
  | "no-structured-schema"
  | "no-streaming"
  | "unauthorized"
  | "unreachable";

export interface CapturedRequest {
  path: string;
  /** Credential headers as received, so tests can prove where a key travelled. */
  authorization: string | null;
  apiKey: string | null;
  body: Record<string, unknown>;
}

export interface ProviderFixture {
  /** Base URL to configure as the provider endpoint. */
  baseUrl: string;
  requests: CapturedRequest[];
  modeFor(modelId: string): FixtureMode;
  reset(): void;
  close(): Promise<void>;
}

const MODELS: Record<string, FixtureMode> = {
  "fixture-model-complete": "complete",
  "fixture-model-no-tools": "no-tools",
  "fixture-model-no-structured": "no-structured-output",
  "fixture-model-json-prose": "no-structured-schema",
  "fixture-model-no-streaming": "no-streaming",
  "fixture-model-unauthorized": "unauthorized",
  "fixture-model-unreachable": "unreachable",
};

export const FIXTURE_MODEL_IDS = Object.keys(MODELS);

const TOOL_CALL_MARKER = "Call the capability_probe tool";
const TOOL_RESULT_PREFIX = "fixture-tool-result:";
const STRUCTURED_MARKER = "Report the probe value";
const STREAM_TEXT = "fixture stream ok";
const STREAM_CHUNKS = [STREAM_TEXT.slice(0, 7), STREAM_TEXT.slice(7)];

/**
 * The schema-conforming answer to the structured-output probe. The shape is
 * enforced by the SDK on the client side; this is what a provider that honours
 * the response format returns.
 */
const STRUCTURED_ANSWER = { answer: "fixture structured ok" };
/**
 * Well-formed JSON of the wrong shape. An endpoint that answers this ignores
 * the requested schema while still producing JSON, which is exactly the case a
 * `JSON.parse` check would wrongly accept.
 */
const STRUCTURED_NONCONFORMING = { prose: "fixture structured ok" };

interface ToolSpec {
  name: string;
  description?: string;
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendEventStream(res: ServerResponse, events: string[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.end(events.join(""));
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object") {
        const record = part as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
      }
      return "";
    })
    .join("\n");
}

function toolSpecs(tools: unknown): ToolSpec[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const fn = (record.function ?? record) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    return name ? [{ name }] : [];
  });
}

/**
 * Decide what a single request should produce. The diagnostic tool prompt asks
 * for a tool call; the follow-up carries the tool result; the structured prompt
 * asks for the schema-bound object; anything else is a plain text prompt.
 */
interface Reply {
  kind: "tool-call" | "final" | "structured" | "text";
  toolName?: string;
  text: string;
}

/**
 * How the request asked for structured output, in the wire protocol of the
 * provider that received it. The structured probe only counts as passed when
 * the endpoint was actually asked for a schema (or, at minimum, JSON mode).
 */
type StructuredRequest = "json-schema" | "json-mode" | null;

function structuredRequestIn(
  path: string,
  body: Record<string, unknown>,
): StructuredRequest {
  const format =
    path === "/openai/v1/responses"
      ? (body.text as { format?: { type?: string } } | undefined)?.format
      : (body.response_format as { type?: string } | undefined);
  if (format?.type === "json_schema") return "json-schema";
  if (format?.type === "json_object") return "json-mode";
  // Anthropic without native structured outputs carries the schema as a forced
  // `json` tool (`tool_choice: any`), which is schema enforcement all the same.
  const forced = body.tool_choice as { type?: string } | undefined;
  const tools = body.tools as Array<{ name?: string; input_schema?: unknown }> | undefined;
  if (forced?.type === "any" && tools?.some((entry) => entry.name === "json" && entry.input_schema)) {
    return "json-schema";
  }
  return null;
}

function replyFor(
  mode: FixtureMode,
  path: string,
  request: Record<string, unknown>,
  prompt: string,
  tools: ToolSpec[],
): Reply {
  if (prompt.includes(TOOL_CALL_MARKER) && mode !== "no-tools" && tools.length > 0) {
    return { kind: "tool-call", toolName: tools[0]!.name, text: "" };
  }
  if (prompt.includes(TOOL_RESULT_PREFIX)) {
    return { kind: "final", text: "fixture tool ok" };
  }
  if (prompt.includes(STRUCTURED_MARKER)) {
    // An endpoint without structured output answers prose, and an endpoint that
    // accepts the response format but ignores the schema answers JSON of the
    // wrong shape. Only the conforming answer may be recorded as supported.
    if (mode === "no-structured-output") {
      return { kind: "structured", text: "fixture structured ok" };
    }
    const payload =
      mode === "no-structured-schema" ? STRUCTURED_NONCONFORMING : STRUCTURED_ANSWER;
    return { kind: "structured", text: JSON.stringify(payload) };
  }
  void request;
  return { kind: "text", text: "fixture text ok" };
}

function flattenItem(item: unknown): string {
  if (Array.isArray(item)) return item.map(flattenItem).join("\n");
  if (!item || typeof item !== "object") return "";
  const record = item as Record<string, unknown>;
  // Responses API tool results arrive as function_call_output items.
  if (typeof record.output === "string") return record.output;
  return flattenText(record.content);
}

function promptOf(body: Record<string, unknown>): string {
  const { input, messages, prompt } = body;
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  if (Array.isArray(input)) parts.push(flattenItem(input));
  if (Array.isArray(messages)) parts.push(flattenItem(messages));
  return parts.join("\n");
}

function streamRequested(body: Record<string, unknown>): boolean {
  return body.stream === true;
}

function openAiResponsesPayload(reply: Reply): unknown {
  const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };
  if (reply.kind === "tool-call") {
    return {
      id: "resp_fixture",
      object: "response",
      created_at: 0,
      model: "fixture",
      status: "completed",
      output: [
        {
          type: "function_call",
          id: "fc_fixture",
          call_id: "call_fixture",
          name: reply.toolName,
          arguments: reply.text || JSON.stringify({ value: "fixture" }),
          status: "completed",
        },
      ],
      usage,
    };
  }
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 0,
    model: "fixture",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        status: "completed",
        // The SDK reads a schema-bound answer from the final-answer phase.
        ...(reply.kind === "structured" ? { phase: "final_answer" } : {}),
        content: [{ type: "output_text", text: reply.text, annotations: [] }],
      },
    ],
    usage,
  };
}

function openAiResponsesEvents(reply: Reply): string[] {
  const events: string[] = [];
  const push = (event: unknown) =>
    events.push(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
  const response = { id: "resp_fixture", object: "response", model: "fixture", status: "in_progress" };
  push({ type: "response.created", response });
  push({ type: "response.in_progress", response });
  if (reply.kind === "tool-call") {
    push({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: reply.toolName,
        arguments: "",
        status: "in_progress",
      },
    });
    push({
      type: "response.function_call_arguments.delta",
      item_id: "fc_fixture",
      output_index: 0,
      delta: reply.text || JSON.stringify({ value: "fixture" }),
    });
    push({
      type: "response.function_call_arguments.done",
      item_id: "fc_fixture",
      output_index: 0,
      arguments: reply.text || JSON.stringify({ value: "fixture" }),
    });
    push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_fixture",
        call_id: "call_fixture",
        name: reply.toolName,
        arguments: reply.text || JSON.stringify({ value: "fixture" }),
        status: "completed",
      },
    });
  } else {
    push({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_fixture", role: "assistant", status: "in_progress", content: [] },
    });
    push({
      type: "response.content_part.added",
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    for (const delta of STREAM_CHUNKS) {
      push({
        type: "response.output_text.delta",
        item_id: "msg_fixture",
        output_index: 0,
        content_index: 0,
        delta,
      });
    }
    push({
      type: "response.output_text.done",
      item_id: "msg_fixture",
      output_index: 0,
      content_index: 0,
      text: STREAM_TEXT,
    });
    push({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_fixture",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: STREAM_TEXT, annotations: [] }],
      },
    });
  }
  push({
    type: "response.completed",
    response: {
      ...response,
      status: "completed",
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    },
  });
  return events;
}

function chatCompletionPayload(reply: Reply): unknown {
  const message =
    reply.kind === "tool-call"
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fixture",
              type: "function",
              function: { name: reply.toolName, arguments: reply.text || JSON.stringify({ value: "fixture" }) },
            },
          ],
        }
      : { role: "assistant", content: reply.text };
  return {
    id: "chatcmpl-fixture",
    object: "chat.completion",
    created: 0,
    model: "fixture",
    choices: [
      {
        index: 0,
        message,
        finish_reason: reply.kind === "tool-call" ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  };
}

function chatCompletionEvents(reply: Reply): string[] {
  const chunk = (delta: unknown, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const events: string[] = [];
  if (reply.kind === "tool-call") {
    events.push(
      chunk(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_fixture",
              type: "function",
              function: { name: reply.toolName, arguments: "" },
            },
          ],
        },
        null,
      ),
    );
    events.push(
      chunk(
        { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ value: "fixture" }) } }] },
        null,
      ),
    );
    events.push(chunk({}, "tool_calls"));
  } else {
    events.push(chunk({ role: "assistant", content: "" }, null));
    for (const delta of STREAM_CHUNKS) events.push(chunk({ content: delta }, null));
    events.push(chunk({}, "stop"));
  }
  events.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    })}\n\n`,
  );
  events.push("data: [DONE]\n\n");
  return events;
}

function anthropicPayload(reply: Reply): unknown {
  const content =
    reply.kind === "tool-call"
      ? [{ type: "tool_use", id: "toolu_fixture", name: reply.toolName, input: { value: "fixture" } }]
      : [{ type: "text", text: reply.text }];
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "fixture",
    content,
    stop_reason: reply.kind === "tool-call" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 3 },
  };
}

function anthropicEvents(reply: Reply): string[] {
  const event = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  const events = [
    event("message_start", {
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    }),
  ];
  if (reply.kind === "tool-call") {
    events.push(
      event("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_fixture", name: reply.toolName, input: {} },
      }),
    );
    events.push(
      event("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ value: "fixture" }) },
      }),
    );
    events.push(event("content_block_stop", { index: 0 }));
    events.push(event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }));
  } else {
    events.push(
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    );
    for (const delta of STREAM_CHUNKS) {
      events.push(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: delta } }));
    }
    events.push(event("content_block_stop", { index: 0 }));
    events.push(event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }));
  }
  events.push(event("message_stop", {}));
  return events;
}

export async function startProviderFixtures(): Promise<ProviderFixture> {
  let requests: CapturedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const path = req.url ?? "/";
      requests.push({
        path,
        authorization: req.headers.authorization ?? null,
        apiKey: (req.headers["x-api-key"] as string | undefined) ?? null,
        body,
      });

      const modelId = typeof body.model === "string" ? body.model : "";
      const mode = MODELS[modelId] ?? "complete";
      if (mode === "unreachable") {
        req.socket.destroy();
        return;
      }
      if (mode === "unauthorized") {
        sendJson(res, 401, { error: { message: "fixture rejects this credential", type: "invalid_request_error" } });
        return;
      }

      const prompt = promptOf(body);
      const reply = replyFor(mode, path, body, prompt, toolSpecs(body.tools));
      const stream = streamRequested(body);

      if (path === "/openai/v1/responses") {
        if (stream) sendEventStream(res, openAiResponsesEvents(reply));
        else sendJson(res, 200, openAiResponsesPayload(reply));
        return;
      }
      if (path === "/anthropic/v1/messages") {
        if (stream) sendEventStream(res, anthropicEvents(reply));
        else sendJson(res, 200, anthropicPayload(reply));
        return;
      }
      if (path.endsWith("/chat/completions")) {
        if (mode === "no-streaming" && stream) {
          sendJson(res, 400, { error: { message: "fixture does not stream", type: "invalid_request_error" } });
          return;
        }
        if (stream) sendEventStream(res, chatCompletionEvents(reply));
        else sendJson(res, 200, chatCompletionPayload(reply));
        return;
      }
      sendJson(res, 404, { error: { message: `fixture has no route ${path}` } });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    modeFor: (modelId) => MODELS[modelId] ?? "complete",
    reset: () => {
      requests = [];
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

/** Every credential a fixture saw, for redaction assertions. */
export function credentialsSeen(requests: CapturedRequest[]): string[] {
  return requests.flatMap((request) =>
    [request.authorization?.replace(/^Bearer\s+/i, ""), request.apiKey].filter(
      (value): value is string => Boolean(value),
    ),
  );
}

/**
 * How each request asked for structured output, in that provider's wire
 * protocol. Tests assert this rather than trusting the reply alone: a probe
 * that never sends a response format cannot prove the endpoint honours one.
 */
export function structuredRequests(requests: CapturedRequest[]): StructuredRequest[] {
  return requests
    .map((request) => structuredRequestIn(request.path, request.body))
    .filter((format): format is Exclude<StructuredRequest, null> => format !== null);
}
