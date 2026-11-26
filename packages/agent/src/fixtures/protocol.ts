/**
 * Provider wire fixtures.
 *
 * These are recorded shapes of what each route actually answers with: a
 * Chat Completions streaming body and a non-streaming tool-call body. The tests
 * serve them through a transport, so a diagnostic is exercised against the
 * protocol rather than against a hand-written stub of the SDK.
 *
 * The bodies are deliberately the providers' own shapes, including the details
 * a "compatible" endpoint commonly gets wrong: an error envelope, a single
 * non-streamed chunk, a tool call whose arguments do not match the declared
 * schema, and an answer that never calls the tool at all.
 */

/** One SSE frame of a Chat Completions stream. */
function frame(
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

/** A streamed answer: the text arrives in parts, then the stream ends. */
export const STREAMED_TEXT = [
  frame({ role: "assistant", content: "" }),
  frame({ content: "rea" }),
  frame({ content: "dy" }),
  frame({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }),
];

/**
 * An answer delivered as one whole chunk. A server that ignores `stream: true`
 * and answers in a single piece is exactly the case that must not be counted
 * as streaming support.
 */
export const UNSTREAMED_TEXT = [
  frame({ role: "assistant", content: "ready" }, "stop", {
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
  }),
];

/** A streamed answer that stops because the model refused the request. */
export const STREAMED_REFUSAL = [
  frame({ role: "assistant", content: "I cannot help with that." }),
  frame({}, "stop", { usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }),
];

/** A well-formed call to the diagnostic tool, with arguments the schema allows. */
export const TOOL_CALL_RESPONSE = {
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1_800_000_000,
  model: "fixture-model",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_fixture",
            type: "function",
            function: {
              name: "record_product_interest",
              arguments: '{"category":"bike helmets","mustBeInStock":true}',
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
};

/** The same call with an argument of the wrong type: the schema is not honoured. */
export const TOOL_CALL_WRONG_TYPES = {
  ...TOOL_CALL_RESPONSE,
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_fixture",
            type: "function",
            function: {
              name: "record_product_interest",
              arguments: '{"category":42,"mustBeInStock":"yes"}',
            },
          },
        ],
      },
    },
  ],
};

/** A provider that answers with prose instead of calling the tool. */
export const TOOL_NOT_CALLED_RESPONSE = {
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1_800_000_000,
  model: "fixture-model",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "I have recorded your interest.",
      },
    },
  ],
  usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 },
};

/** An endpoint that does not speak the Chat Completions protocol at all. */
export const HTML_RESPONSE = "<!doctype html><html><body>Not found</body></html>";

/** A provider's own error envelope, which must not be echoed to a shopper. */
export function errorResponse(message: string) {
  return { error: { message, type: "invalid_request_error", param: null, code: null } };
}
