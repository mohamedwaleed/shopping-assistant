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
import {
  createEngine,
  ConversationNotFoundError,
  HardConstraintRelaxationRefusedError,
  type Engine,
} from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

describe("shopper requirements", () => {
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

  it("adds a new hard constraint without needing the shopper's agreement", async () => {
    const conversation = await engine.conversations.create(shopperId, {
      title: "Standing desk",
    });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 400 euros" }],
      preferences: [],
    });

    const revised = await engine.requirements.revise(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Must fit under a 120 cm ceiling" }],
    });

    expect(revised.hardConstraints.map((requirement) => requirement.statement)).toEqual([
      "Costs at most 400 euros",
      "Must fit under a 120 cm ceiling",
    ]);
  });

  it("keeps preferences when an unapproved hard-constraint change is refused", async () => {
    const conversation = await engine.conversations.create(shopperId, {
      title: "Office chair",
    });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 300 euros" }],
      preferences: [],
    });

    await expect(
      engine.requirements.revise(shopperId, conversation.id, {
        retract: [{ statement: "Costs at most 300 euros" }],
        hardConstraints: [{ statement: "Costs at most 500 euros" }],
        preferences: [{ statement: "Prefer mesh" }],
      }),
    ).rejects.toThrow(HardConstraintRelaxationRefusedError);

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.hardConstraints.map((requirement) => requirement.statement)).toEqual([
      "Costs at most 300 euros",
    ]);
    expect(reopened.preferences).toEqual([]);
  });

  it("keeps a budget as a hard constraint and a weight as a preference", async () => {
    const conversation = await engine.conversations.create(shopperId, {
      title: "A quiet dishwasher for a small kitchen",
    });

    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [
        { statement: "Costs at most 600 euros" },
        { statement: "42 dB or quieter" },
      ],
      preferences: [{ statement: "Prefers a stainless steel finish" }],
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.hardConstraints.map((requirement) => requirement.statement)).toEqual([
      "Costs at most 600 euros",
      "42 dB or quieter",
    ]);
    expect(reopened.preferences.map((requirement) => requirement.statement)).toEqual([
      "Prefers a stainless steel finish",
    ]);
  });

  it("summarizes which requirements are hard constraints and which are preferences", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Espresso machine" });

    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 400 euros" }],
      preferences: [{ statement: "Prefers a manual lever" }, { statement: "Quiet grinder" }],
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.summary).toBe(
      "Hard constraints: Costs at most 400 euros. Preferences: Prefers a manual lever; Quiet grinder.",
    );
  });

  it("applies a shopper's revision to one conversation only", async () => {
    const revised = await engine.conversations.create(shopperId, { title: "Winter coat" });
    const untouched = await engine.conversations.create(shopperId, { title: "Garden chair" });
    await engine.requirements.set(shopperId, revised.id, {
      hardConstraints: [{ statement: "Costs at most 300 euros" }],
      preferences: [{ statement: "Prefers a dark colour" }],
    });
    await engine.requirements.set(shopperId, untouched.id, {
      hardConstraints: [{ statement: "Costs at most 300 euros" }],
      preferences: [{ statement: "Prefers a dark colour" }],
    });

    await engine.requirements.revise(shopperId, revised.id, {
      hardConstraints: [{ statement: "Costs at most 450 euros" }],
      approvedByShopper: true,
    });

    const changed = await engine.requirements.get(shopperId, revised.id);
    const independent = await engine.requirements.get(shopperId, untouched.id);

    expect(changed.summary).toBe(
      "Hard constraints: Costs at most 300 euros; Costs at most 450 euros. Preferences: Prefers a dark colour.",
    );
    expect(independent.summary).toBe(
      "Hard constraints: Costs at most 300 euros. Preferences: Prefers a dark colour.",
    );
  });

  it("refuses to drop a hard constraint without the shopper's agreement", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Running shoes" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 120 euros" }],
      preferences: [{ statement: "Prefers a trail sole" }],
    });

    await expect(
      engine.requirements.revise(shopperId, conversation.id, {
        retract: [{ statement: "Costs at most 120 euros" }],
        hardConstraints: [{ statement: "Costs at most 180 euros" }],
      }),
    ).rejects.toThrow(HardConstraintRelaxationRefusedError);

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.summary).toBe(
      "Hard constraints: Costs at most 120 euros. Preferences: Prefers a trail sole.",
    );
  });

  it("revises a preference without asking the shopper to approve it", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Desk lamp" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 80 euros" }],
      preferences: [{ statement: "Prefers a warm light colour" }],
    });

    await engine.requirements.revise(shopperId, conversation.id, {
      preferences: [{ statement: "Prefers a neutral light colour" }],
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.summary).toBe(
      "Hard constraints: Costs at most 80 euros. Preferences: Prefers a warm light colour; Prefers a neutral light colour.",
    );
  });

  it("relaxes a hard constraint the shopper has agreed to relax", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Bike helmet" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 90 euros" }],
      preferences: [{ statement: "Prefers a MIPS liner" }],
    });

    await engine.requirements.revise(shopperId, conversation.id, {
      retract: [{ statement: "Costs at most 90 euros" }],
      hardConstraints: [{ statement: "Costs at most 130 euros" }],
      approvedByShopper: true,
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.summary).toBe(
      "Hard constraints: Costs at most 130 euros. Preferences: Prefers a MIPS liner.",
    );
  });

  it("keeps requirements across a follow-up message", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Coffee grinder" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Plugs into a Dutch socket" }],
      preferences: [{ statement: "Prefers a conical burr" }],
    });

    await engine.conversations.appendMessage(shopperId, conversation.id, {
      role: "user",
      content: "Actually, I'd like something quieter as well.",
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);
    const withFollowUp = await engine.conversations.get(shopperId, conversation.id);

    expect(reopened.summary).toBe(
      "Hard constraints: Plugs into a Dutch socket. Preferences: Prefers a conical burr.",
    );
    expect(withFollowUp.messages.map((message) => message.content)).toEqual([
      "Actually, I'd like something quieter as well.",
    ]);
  });

  it("summarizes a conversation that has only preferences", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Garden chair" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [],
      preferences: [{ statement: "Prefers teak" }],
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.summary).toBe("Hard constraints: none. Preferences: Prefers teak.");
  });

  it("classifies requirements by kind even when the same statement is saved under the other", async () => {
    const conversation = await engine.conversations.create(shopperId, { title: "Office chair" });
    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [],
      preferences: [{ statement: "Costs at most 200 euros" }],
    });

    await engine.requirements.set(shopperId, conversation.id, {
      hardConstraints: [{ statement: "Costs at most 200 euros" }],
      preferences: [],
    });

    const reopened = await engine.requirements.get(shopperId, conversation.id);

    expect(reopened.hardConstraints.map((requirement) => requirement.statement)).toEqual([
      "Costs at most 200 euros",
    ]);
    expect(reopened.preferences.map((requirement) => requirement.statement)).toEqual([
      "Costs at most 200 euros",
    ]);
    expect(reopened.summary).toBe(
      "Hard constraints: Costs at most 200 euros. Preferences: Costs at most 200 euros.",
    );
  });

  describe("privacy between accounts", () => {
    it("hides a conversation's requirements from another account", async () => {
      const ownerId = await createAccount(database, "owner@example.com");
      const strangerId = await createAccount(database, "stranger@example.com");
      const conversation = await engine.conversations.create(ownerId, { title: "Running shoes" });
      await engine.requirements.set(ownerId, conversation.id, {
        hardConstraints: [{ statement: "Costs at most 120 euros" }],
        preferences: [],
      });

      await expect(engine.requirements.get(strangerId, conversation.id)).rejects.toThrow(
        ConversationNotFoundError,
      );
    });

    it("refuses to save or revise requirements in another account's conversation", async () => {
      const ownerId = await createAccount(database, "owner2@example.com");
      const strangerId = await createAccount(database, "stranger2@example.com");
      const conversation = await engine.conversations.create(ownerId, { title: "Desk lamp" });
      await engine.requirements.set(ownerId, conversation.id, {
        hardConstraints: [{ statement: "Costs at most 80 euros" }],
        preferences: [],
      });

      await expect(
        engine.requirements.set(strangerId, conversation.id, {
          hardConstraints: [],
          preferences: [{ statement: "Prefers a wooden base" }],
        }),
      ).rejects.toThrow(ConversationNotFoundError);
      await expect(
        engine.requirements.revise(strangerId, conversation.id, {
          hardConstraints: [{ statement: "Costs at most 500 euros" }],
          approvedByShopper: true,
        }),
      ).rejects.toThrow(ConversationNotFoundError);

      const reopened = await engine.requirements.get(ownerId, conversation.id);
      expect(reopened.summary).toBe("Hard constraints: Costs at most 80 euros. Preferences: none.");
    });

    it("reports an unknown conversation the same way as a foreign one", async () => {
      const shopper = await createAccount(database, "curious@example.com");
      const foreign = await engine.conversations.create(
        await createAccount(database, "someone@example.com"),
        { title: "A private plan" },
      );

      const foreignError = await engine.requirements
        .get(shopper, foreign.id)
        .catch((error: unknown) => error);
      const unknownError = await engine.requirements
        .get(shopper, "00000000-0000-4000-8000-000000000000")
        .catch((error: unknown) => error);

      expect(foreignError).toBeInstanceOf(ConversationNotFoundError);
      expect(unknownError).toBeInstanceOf(ConversationNotFoundError);
      expect((foreignError as Error).message).toBe((unknownError as Error).message);
    });
  });
});
