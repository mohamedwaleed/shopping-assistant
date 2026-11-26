import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import {
  createAccount,
  createTestSchema,
  migrate,
} from "@shopping-assistant/database/testing";
import { createEngine, ConversationNotFoundError, type Engine } from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

describe("shopping conversations", () => {
  let admin: Database;
  let database: Database;
  let engine: Engine;
  let shopperId: string;
  let dropSchema: () => Promise<void>;

  beforeAll(async () => {
    const connection = databaseUrlFromEnvironment();
    admin = connectDatabase(connection);
    const { schema, drop } = await createTestSchema(admin);
    dropSchema = drop;
    database = connectDatabase(withSearchPath(connection, schema));
    await migrate(database);
    engine = createEngine({
      database,
      setupToken: "unused-in-these-tests",
      identity: createFakeIdentityStore(database),
    });
    shopperId = await createAccount(database, "shopper@example.com");
  });

  afterAll(async () => {
    await database?.destroy();
    await dropSchema?.();
    await admin?.destroy();
  });

  it("keeps messages a shopper appends to their conversation", async () => {
    const conversation = await engine.conversations.create(shopperId, {
      title: "A quiet dishwasher for a small kitchen",
    });

    await engine.conversations.appendMessage(shopperId, conversation.id, {
      role: "user",
      content: "I need a quiet dishwasher under 600 euros.",
    });

    const reopened = await engine.conversations.get(shopperId, conversation.id);

    expect(reopened.id).toBe(conversation.id);
    expect(reopened.title).toBe("A quiet dishwasher for a small kitchen");
    expect(reopened.messages.map((message) => message.content)).toEqual([
      "I need a quiet dishwasher under 600 euros.",
    ]);
    expect(reopened.messages[0]?.role).toBe("user");
  });

  it("lists a shopper's conversations with the most recent first", async () => {
    const otherShopperId = await createAccount(database, "collector@example.com");
    const earlier = await engine.conversations.create(otherShopperId, { title: "Winter coat" });
    const later = await engine.conversations.create(otherShopperId, { title: "Coffee grinder" });

    const listed = await engine.conversations.list(otherShopperId);

    expect(listed.map((conversation) => conversation.id)).toEqual([later.id, earlier.id]);
    expect(listed.map((conversation) => conversation.title)).toEqual([
      "Coffee grinder",
      "Winter coat",
    ]);
  });

  it("returns messages in the order they were sent", async () => {
    const orderingId = await createAccount(database, "ordering@example.com");
    const conversation = await engine.conversations.create(orderingId, { title: "Espresso machine" });

    const sent = ["Under 400 euros.", "Prefer a manual lever.", "Must fit a 30 cm counter."];
    for (const content of sent) {
      await engine.conversations.appendMessage(orderingId, conversation.id, {
        role: "user",
        content,
      });
    }
    await engine.conversations.appendMessage(orderingId, conversation.id, {
      role: "assistant",
      content: "Here are three options.",
    });

    const reopened = await engine.conversations.get(orderingId, conversation.id);

    expect(reopened.messages.map((message) => message.content)).toEqual([
      ...sent,
      "Here are three options.",
    ]);
    expect(reopened.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
      "assistant",
    ]);
  });

  describe("privacy between accounts", () => {
    it("hides another account's conversation from list and get", async () => {
      const ownerId = await createAccount(database, "owner@example.com");
      const strangerId = await createAccount(database, "stranger@example.com");
      const conversation = await engine.conversations.create(ownerId, { title: "Running shoes" });
      await engine.conversations.appendMessage(ownerId, conversation.id, {
        role: "user",
        content: "Budget of 120 euros for trail shoes.",
      });

      expect(await engine.conversations.list(strangerId)).toEqual([]);
      await expect(engine.conversations.get(strangerId, conversation.id)).rejects.toThrow(
        ConversationNotFoundError,
      );
    });

    it("refuses to append a message to another account's conversation", async () => {
      const ownerId = await createAccount(database, "owner2@example.com");
      const strangerId = await createAccount(database, "stranger2@example.com");
      const conversation = await engine.conversations.create(ownerId, { title: "Desk lamp" });

      await expect(
        engine.conversations.appendMessage(strangerId, conversation.id, {
          role: "user",
          content: "Injecting a message into someone else's conversation.",
        }),
      ).rejects.toThrow(ConversationNotFoundError);

      const reopened = await engine.conversations.get(ownerId, conversation.id);
      expect(reopened.messages).toEqual([]);
    });

    it("reports an unknown conversation the same way as a foreign one", async () => {
      const shopper = await createAccount(database, "curious@example.com");
      const foreign = await engine.conversations.create(
        await createAccount(database, "someone@example.com"),
        { title: "A private plan" },
      );

      const foreignError = await engine.conversations
        .get(shopper, foreign.id)
        .catch((error: unknown) => error);
      const unknownError = await engine.conversations
        .get(shopper, "00000000-0000-4000-8000-000000000000")
        .catch((error: unknown) => error);

      expect(foreignError).toBeInstanceOf(ConversationNotFoundError);
      expect(unknownError).toBeInstanceOf(ConversationNotFoundError);
      expect((foreignError as Error).message).toBe((unknownError as Error).message);
    });
  });
});
