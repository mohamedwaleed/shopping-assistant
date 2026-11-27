import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, migrate } from "@shopping-assistant/database/testing";
import { createEngine, type Engine } from "@shopping-assistant/engine";
import {
  conversationFixtureTransport,
  frame,
  type ConversationFixtureStep,
} from "@shopping-assistant/agent/fixtures";
import { createConversationAgent, type ModelConfiguration } from "@shopping-assistant/agent";
import { createAuth, type Auth } from "./auth.ts";
import { createAuthServer } from "./auth-http.ts";
import { createConversationServer } from "./conversation-http.ts";
import { createIdentityStore } from "./identity.ts";
import { createRecordingMailer } from "./mailer.ts";

const AUTH_SECRET = "auth-secret-7d1f2b3c4e5a69788796a5b4c3d2e1f0";
const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const PASSWORD = "correct-horse-battery-staple";
const API_KEY = "sk-fixture-8d3f1a5c7e9b";

/** A Dutch answer, streamed in parts, so the saved message can be checked. */
const DUTCH_ANSWER = [
  frame({ role: "assistant", content: "" }),
  frame({ content: "Hier " }),
  frame({ content: "zijn " }),
  frame({ content: "drie opties." }),
  frame({}, "stop", { usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 } }),
];

const TEXT_ONLY: ConversationFixtureStep[] = [{ kind: "text", frames: DUTCH_ANSWER }];

const configuration: ModelConfiguration = {
  providers: [
    {
      id: "compatible",
      route: "openai-compatible",
      apiKey: API_KEY,
      baseUrl: "https://llm.example.com/v1",
    },
  ],
  models: [{ id: "balanced", provider: "compatible", model: "fixture-model" }],
};

interface ServedInstallation {
  database: Database;
  engine: Engine;
  auth: Auth;
  mailer: ReturnType<typeof createRecordingMailer>;
  origin: string;
  captured: ReturnType<typeof conversationFixtureTransport>["captured"];
  close: () => Promise<void>;
}

let server: Database;

/**
 * A bootstrapped installation with the conversation route mounted and a model
 * provider answered from the given fixture steps, so no test reaches a
 * network.
 */
async function serveInstallation({
  steps = TEXT_ONLY,
}: { steps?: ConversationFixtureStep[] } = {}): Promise<ServedInstallation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  const mailer = createRecordingMailer();
  // The origin is only known once the server listens, and Better Auth builds
  // its links from it, so the instance is created after the port is bound.
  let auth!: Auth;
  let engine!: Engine;
  const transport = conversationFixtureTransport(steps);
  const httpServer = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname.startsWith("/conversations")) {
      return createConversationServer({
        auth,
        engine,
        agent: createConversationAgent({
          engine,
          configuration,
          fetch: transport.fetch,
        }),
      })(request, response);
    }
    return createAuthServer({ auth, engine })(request, response);
  });
  await new Promise<void>((listening) => httpServer.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  const engineHolder: { engine?: Engine } = {};
  const identity = {
    createUser: (
      ...args: Parameters<ReturnType<typeof createIdentityStore>["createUser"]>
    ) => createIdentityStore(auth).createUser(...args),
    findUserByEmail: (email: string) => createIdentityStore(auth).findUserByEmail(email),
    revokeSessions: (identityId: string) => createIdentityStore(auth).revokeSessions(identityId),
  };
  auth = createAuth({
    database,
    secret: AUTH_SECRET,
    baseUrl: origin,
    mailer,
    installation: async () => ({
      bootstrapped: !(await engineHolder.engine!.setup.readiness()).setup.includes("open"),
      registrationOpen: await engineHolder.engine!.accounts.isRegistrationOpen(),
    }),
  });
  engine = createEngine({ database, setupToken: SETUP_TOKEN, identity });
  engineHolder.engine = engine;
  await engine.setup.complete({
    setupToken: SETUP_TOKEN,
    email: "operator@example.com",
    password: PASSWORD,
  });

  return {
    database,
    engine,
    auth,
    mailer,
    origin,
    captured: transport.captured,
    close: async () => {
      await new Promise<void>((closed) => httpServer.close(() => closed()));
      await database.destroy();
      await drop();
    },
  };
}

/** Registers, verifies, and signs in one shopper, returning the session cookie. */
async function shopperCookie(installation: ServedInstallation, email: string): Promise<string> {
  const signedUp = await post(installation.origin, "/api/auth/sign-up/email", {
    name: email.split("@")[0] ?? email,
    email,
    password: PASSWORD,
  });
  expect(signedUp.status).toBe(200);
  const link = verificationLink(installation, email);
  await fetch(link, { redirect: "manual" });
  const signedIn = await post(installation.origin, "/api/auth/sign-in/email", {
    email,
    password: PASSWORD,
  });
  expect(signedIn.status).toBe(200);
  return cookieFrom(signedIn);
}

function post(origin: string, path: string, body: unknown, cookie?: string) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.getSetCookie().join("; ");
  return header
    .split("; ")
    .filter((part) => part.includes("="))
    .map((part) => part.split(";")[0])
    .join("; ");
}

function verificationLink(
  installation: ServedInstallation,
  recipient: string,
): string {
  const message = installation.mailer.sent.filter((sent) => sent.to === recipient).at(-1);
  if (!message) throw new Error(`No verification email was sent to ${recipient}`);
  const match = message.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error("No link in the verification email");
  return match[0];
}

function ndjson(body: string): Record<string, unknown>[] {
  return body
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("the streamed conversation contract", () => {
  it("streams a tool-backed turn and reloads the saved conversation", async () => {
    const installation = await serveInstallation({
      steps: [
        {
          kind: "tool-call",
          tool: "record_requirements",
          arguments: { hardConstraints: ["Kost maximaal 600 euro"], preferences: [] },
        },
        { kind: "text", frames: DUTCH_ANSWER },
      ],
    });
    const cookie = await shopperCookie(installation, "shopper@example.com");
    const conversation = await installation.engine.conversations.create(
      (await installation.engine.accounts.findByEmail("shopper@example.com"))!.id,
      { title: "Stille vaatwasser" },
    );

    const streamed = await post(
      installation.origin,
      `/conversations/${conversation.id}/messages`,
      { message: "Ik zoek een stille vaatwasser onder 600 euro." },
      cookie,
    );

    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toContain("application/x-ndjson");
    const streamedBody = await streamed.text();
    const events = ndjson(streamedBody);
    expect(events.map((event) => event.type)).toEqual([
      "user-message-persisted",
      "tool-started",
      "tool-result",
      "text-delta",
      "text-delta",
      "text-delta",
      "complete",
    ]);
    expect(events).toContainEqual({
      type: "tool-result",
      tool: "record_requirements",
      ok: true,
      note: "requirements recorded",
    });
    const deltas = events
      .filter((event) => event.type === "text-delta")
      .map((event) => (event as { delta: string }).delta)
      .join("");

    // The saved conversation is the one the GET returns, and its assistant
    // message is exactly what the stream produced.
    const saved = await fetch(`${installation.origin}/conversations/${conversation.id}`, {
      headers: { cookie },
    });
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as {
      id: string;
      messages: { role: string; content: string }[];
    };
    expect(savedBody.id).toBe(conversation.id);
    expect(savedBody.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(savedBody.messages[1]?.content).toBe(deltas);
    // The tool's outcome landed in the engine's own store.
    const requirements = await installation.engine.requirements.get(
      (await installation.engine.accounts.findByEmail("shopper@example.com"))!.id,
      conversation.id,
    );
    expect(requirements.hardConstraints.map((requirement) => requirement.statement)).toEqual([
      "Kost maximaal 600 euro",
    ]);
    // No credential ever appears in the streamed events.
    expect(streamedBody).not.toContain(API_KEY);

    await installation.close();
  });

  it("refuses another account's conversation and message the same way as an unknown one", async () => {
    const installation = await serveInstallation();
    await shopperCookie(installation, "owner@example.com");
    const strangerCookie = await shopperCookie(installation, "stranger@example.com");
    const ownerAccount = (await installation.engine.accounts.findByEmail("owner@example.com"))!;
    const conversation = await installation.engine.conversations.create(ownerAccount.id, {
      title: "Een privéplan",
    });
    await installation.engine.conversations.appendMessage(ownerAccount.id, conversation.id, {
      role: "user",
      content: "Alleen voor de eigenaar.",
    });

    const foreign = await post(
      installation.origin,
      `/conversations/${conversation.id}/messages`,
      { message: "Mag ik meekijken?" },
      strangerCookie,
    );
    const unknown = await post(
      installation.origin,
      "/conversations/00000000-0000-4000-8000-000000000000/messages",
      { message: "Mag ik meekijken?" },
      strangerCookie,
    );

    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await foreign.text()).toBe(await unknown.text());
    // Nothing was streamed and nothing was written by the attempt.
    const reopened = await installation.engine.conversations.get(ownerAccount.id, conversation.id);
    expect(reopened.messages.map((message) => message.content)).toEqual([
      "Alleen voor de eigenaar.",
    ]);
    // The model was never asked, so the attempt cost nothing.
    expect(installation.captured).toEqual([]);

    await installation.close();
  });

  it("requires a session before a conversation can be read or written", async () => {
    const installation = await serveInstallation();
    const account = (await installation.engine.accounts.findByEmail("operator@example.com"))!;
    const conversation = await installation.engine.conversations.create(account.id, {
      title: "Zonder sessie",
    });

    const read = await fetch(`${installation.origin}/conversations/${conversation.id}`);
    const write = await post(
      installation.origin,
      `/conversations/${conversation.id}/messages`,
      { message: "Hallo" },
    );

    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
    expect(installation.captured).toEqual([]);

    await installation.close();
  });

  it("surfaces a provider failure as an explicit error line and keeps the saved message", async () => {
    const installation = await serveInstallation({
      steps: [
        {
          kind: "status",
          status: 401,
          body: {
            error: {
              message: `Incorrect API key provided: ${API_KEY}`,
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          },
        },
      ],
    });
    const cookie = await shopperCookie(installation, "shopper@example.com");
    const account = (await installation.engine.accounts.findByEmail("shopper@example.com"))!;
    const conversation = await installation.engine.conversations.create(account.id, {
      title: "Stille vaatwasser",
    });

    const streamed = await post(
      installation.origin,
      `/conversations/${conversation.id}/messages`,
      { message: "Ik zoek een stille vaatwasser." },
      cookie,
    );

    expect(streamed.status).toBe(200);
    const events = ndjson(await streamed.text());
    const error = events.find((event) => event.type === "error") as
      | { problem: string }
      | undefined;
    expect(error?.problem).toBe("the model provider rejected the credential");
    // The provider's own message never reaches the transport.
    expect(streamed.headers.get("content-type")).toContain("application/x-ndjson");
    expect(JSON.stringify(events)).not.toContain(API_KEY);
    expect(JSON.stringify(events)).not.toContain("Incorrect API key");

    // The history kept the user message and no half-written answer.
    const saved = await fetch(`${installation.origin}/conversations/${conversation.id}`, {
      headers: { cookie },
    });
    const savedBody = (await saved.json()) as { messages: { role: string }[] };
    expect(savedBody.messages.map((message) => message.role)).toEqual(["user"]);

    await installation.close();
  });
});