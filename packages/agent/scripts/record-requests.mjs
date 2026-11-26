/**
 * Records the request bodies the AI SDK produces for each route, so the
 * fixtures the tests replay are the SDK's real wire format rather than a guess
 * at it. Run with the agent package's dependencies installed:
 *
 *   node scripts/record-requests.mjs
 *
 * The output is written to `src/fixtures/recorded-requests.json`. It is a
 * development aid, not part of the test run: the tests only read the file.
 */
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateText, jsonSchema, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "..", "src", "fixtures", "recorded-requests.json");

const tool = {
  description:
    "Record that the shopper is interested in a product category. Call this exactly once.",
  inputSchema: jsonSchema({
    type: "object",
    properties: {
      category: { type: "string", description: "The product category to record." },
      mustBeInStock: { type: "boolean", description: "Whether only in-stock offers qualify." },
    },
    required: ["category", "mustBeInStock"],
    additionalProperties: false,
  }),
};
const tools = { record_product_interest: tool };

const captured = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8");
  captured.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
  if (JSON.parse(body).stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const frame = (delta, finish = null, extra = {}) =>
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-recorded",
          object: "chat.completion.chunk",
          created: 1,
          model: "recorded",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`,
      );
    frame({ role: "assistant", content: "Hel" });
    frame({ content: "lo" });
    frame({}, "stop", {
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: "chatcmpl-recorded",
      object: "chat.completion",
      created: 1,
      model: "recorded",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_recorded",
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
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
  );
});
await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
const base = `http://127.0.0.1:${server.address().port}`;

const routes = {
  openai: () => createOpenAI({ apiKey: "recorded", baseURL: `${base}/v1` }).chat("gpt-4o-mini"),
  "openai-compatible": () =>
    createOpenAICompatible({
      name: "compatible",
      baseURL: `${base}/v1`,
      apiKey: "recorded",
      includeUsage: true,
    }).chatModel("local-model"),
  openrouter: () =>
    createOpenAICompatible({
      name: "openrouter",
      baseURL: `${base}/api/v1`,
      apiKey: "recorded",
      includeUsage: true,
      headers: { "HTTP-Referer": "http://localhost:3000", "X-Title": "shopping-assistant" },
    }).chatModel("openai/gpt-4o-mini"),
};

const recorded = {};
for (const [route, modelOf] of Object.entries(routes)) {
  captured.length = 0;
  await generateText({
    model: modelOf(),
    tools,
    toolChoice: { type: "tool", toolName: "record_product_interest" },
    prompt: "Record the shopper's interest in bike helmets, in stock only.",
    maxOutputTokens: 64,
    maxRetries: 0,
  });
  await streamText({
    model: modelOf(),
    prompt: "Reply with the single word: ready.",
    maxOutputTokens: 64,
    maxRetries: 0,
  }).text;
  recorded[route] = captured.map((entry) => ({
    method: "POST",
    url: entry.url,
    headers: Object.fromEntries(
      Object.entries(entry.headers).filter(([name]) =>
        ["authorization", "content-type", "http-referer", "x-title"].includes(name),
      ),
    ),
    body: entry.body,
  }));
}
server.close();

await writeFile(output, `${JSON.stringify(recorded, null, 2)}\n`);
process.stdout.write(`Recorded ${Object.keys(recorded).length} routes to ${output}\n`);
