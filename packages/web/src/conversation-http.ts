import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  ConversationNotFoundError,
  ResearchAllowanceExhaustedError,
  type ConversationWithMessages,
  type Engine,
} from "@shopping-assistant/engine";
import { ModelConfigurationError, type ConversationAgent } from "@shopping-assistant/agent";
import type { Auth } from "./auth.ts";
import { currentUser } from "./identity.ts";

const CONVERSATIONS_PATH = "/conversations";
const MAXIMUM_BODY_BYTES = 4_096;

/**
 * The thin authenticated contract for streamed conversations.
 *
 *   GET  /conversations/:id        the saved conversation, or 404 for a
 *                                  conversation that is not the caller's
 *   POST /conversations/:id/messages  streams the assistant's answer as NDJSON
 *
 * The caller's identity comes from the verified session, never from the body.
 * The engine is the only authority on whether a conversation exists or
 * belongs to the caller, so an unknown conversation and another account's
 * conversation are both a 404 before anything is written.
 */
export function createConversationServer({
  auth,
  engine,
  agent,
}: {
  auth: Auth;
  engine: Engine;
  agent: ConversationAgent;
}): RequestListener {
  return (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const { method } = request;

    void (async () => {
      const messagesMatch = /^\/conversations\/([^/]+)\/messages$/.exec(pathname);
      const conversationMatch = /^\/conversations\/([^/]+)$/.exec(pathname);
      if (!messagesMatch && !conversationMatch) {
        send(response, 404, { error: "Not found" });
        return;
      }

      const user = await currentUser(auth, request, engine.accounts);
      if (!user) {
        send(response, 401, { error: "Authentication required" });
        return;
      }

      try {
        if (conversationMatch && method === "GET") {
          await showConversation(response, user.id, conversationMatch[1] ?? "");
          return;
        }
        if (messagesMatch && method === "POST") {
          await streamMessage(request, response, user.id, messagesMatch[1] ?? "");
          return;
        }
        send(response, 405, { error: "Method not allowed" });
      } catch (error) {
        refuse(response, error);
      }
    })().catch(() => {
      if (!response.headersSent) send(response, 500, { error: "Conversations failed" });
    });
  };

  /** The saved conversation, with its messages in the order they were sent. */
  async function showConversation(
    response: ServerResponse,
    userId: string,
    conversationId: string,
  ): Promise<void> {
    // The engine is the only authority on whether the conversation exists and
    // belongs to the caller; a foreign or unknown conversation is the same 404.
    const conversation = await engine.conversations.get(userId, conversationId);
    send(response, 200, conversationView(conversation));
  }

  /**
   * Runs one turn and streams its events as NDJSON, one JSON object per line.
   *
   * The first event is pulled before the response headers are written, so a
   * refusal — a foreign conversation, an exhausted allowance, no model — is an
   * ordinary JSON error with a status, never a 200 that then says nothing.
   * Once the stream has started, a provider or transport failure is the final
   * `{"type":"error","problem":...}` line, which is how an explicit error
   * travels over a stream whose status is already sent.
   */
  async function streamMessage(
    request: IncomingMessage,
    response: ServerResponse,
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const body = await readJson(request).catch((error: unknown) => error);
    if (body instanceof RangeError) {
      send(response, 413, { error: "Request body too large" });
      return;
    }
    if (body instanceof SyntaxError) {
      // A body that is not JSON is not a shopper's message; persisting it
      // would burn a whole turn on garbage.
      send(response, 400, { error: "Expected a JSON body" });
      return;
    }
    const message = (body as Record<string, unknown> | undefined)?.message;
    if (typeof message !== "string" || message.trim().length === 0) {
      send(response, 400, { error: "Expected a message" });
      return;
    }

    const turn = agent.streamTurn({ userId, conversationId, message });
    // Ownership, persistence, and the model reservation happen before the
    // first event, so a refusal here still has clean headers to answer with.
    const first = await turn.next();

    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (!first.done) response.write(`${JSON.stringify(first.value)}\n`);
    for await (const event of turn) {
      response.write(`${JSON.stringify(event)}\n`);
    }
    response.end();
  }
}

/**
 * One place for what each refusal means over HTTP. Unknown conversations and
 * other accounts' conversations are the same 404, and an exhausted research
 * allowance is named so a shopper can tell a budget from a fault.
 */
function refuse(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    // Streaming has begun: a terminal event, not a bare EOF, so a client
    // reading events is never left wondering whether the turn ended.
    response.write(`${JSON.stringify({ type: "error", problem: "the turn could not be completed" })}
`);
    response.end();
    return;
  }
  if (error instanceof ConversationNotFoundError) {
    send(response, 404, { error: "Conversation not found" });
    return;
  }
  if (error instanceof ResearchAllowanceExhaustedError) {
    send(response, 429, { error: error.message });
    return;
  }
  if (error instanceof ModelConfigurationError) {
    send(response, 503, { error: error.message });
    return;
  }
  throw error;
}

/** The saved conversation as the transport returns it: no engine internals. */
function conversationView(conversation: ConversationWithMessages): unknown {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt.toISOString(),
    messages: conversation.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAXIMUM_BODY_BYTES) throw new RangeError("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}