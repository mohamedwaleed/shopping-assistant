import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createAccount, createTestSchema, migrate } from "@shopping-assistant/database/testing";
import { ConversationNotFoundError, createEngine, type Engine } from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

let server: Database;

describe("conversation privacy against administrators", () => {
  let database: Database;
  let engine: Engine;
  let adminId: string;
  let shopperId: string;
  let dropSchema: () => Promise<void>;

  beforeAll(async () => {
    const connection = databaseUrlFromEnvironment();
    server = connectDatabase(connection);
    const created = await createTestSchema(server);
    dropSchema = created.drop;
    database = connectDatabase(withSearchPath(connection, created.schema));
    await migrate(database);
    engine = createEngine({
      database,
      setupToken: "unused-in-these-tests",
      identity: createFakeIdentityStore(database),
    });
    adminId = await createAccount(database, "operator@example.com");
    shopperId = await createAccount(database, "shopper@example.com");
    // An installation always exists with at least one active admin, and the
    // database refuses any other state, so the fixture records both together.
    await database.transaction(async (transaction) => {
      await transaction("installation").insert({ initial_admin_created_at: transaction.fn.now() });
      await transaction("profiles").where({ id: adminId }).update({ role: "admin" });
    });
  });

  afterAll(async () => {
    await database?.destroy();
    await dropSchema?.();
    await server?.destroy();
  });

  it("does not let an admin read another shopper's conversation", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Bike helmet" });
    await engine.conversations.appendMessage(shopperId, conversation.id, {
      role: "user",
      content: "I need a MIPS helmet under 200 euros.",
    });

    // Admin permission is about access, not data: the conversation stays the
    // shopper's, so reading it as the admin is indistinguishable from reading a
    // conversation that does not exist.
    await expect(engine.conversations.get(adminId, conversation.id)).rejects.toThrow(
      ConversationNotFoundError,
    );
    await expect(
      engine.conversations.appendMessage(adminId, conversation.id, {
        role: "user",
        content: "Admin was here",
      }),
    ).rejects.toThrow(ConversationNotFoundError);
    await expect(engine.requirements.get(adminId, conversation.id)).rejects.toThrow(
      ConversationNotFoundError,
    );

    // The shopper's own view is untouched.
    const own = await engine.conversations.get(shopperId, conversation.id);
    expect(own.messages.map((message) => message.content)).toEqual([
      "I need a MIPS helmet under 200 euros.",
    ]);
  });

  it("does not list another shopper's conversations for an admin", async () => {
    const conversations = await engine.conversations.list(adminId);

    expect(conversations).toEqual([]);
  });

  it("keeps an admin's own conversations private too", async () => {
    const own = await engine.conversations.create(adminId, { title: "Operator notes" });

    await expect(engine.conversations.get(shopperId, own.id)).rejects.toThrow(
      ConversationNotFoundError,
    );
  });
});
