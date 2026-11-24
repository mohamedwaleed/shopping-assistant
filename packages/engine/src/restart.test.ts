import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createAccount, createTestSchema, migrate } from "@shopping-assistant/database/testing";
import { createEngine, type Engine } from "./index.ts";

const run = promisify(execFile);
const writerScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "testing",
  "write-conversation.ts",
);

describe("conversation persistence across process restart", () => {
  let admin: Database;
  let database: Database;
  let engine: Engine;
  let schema: string;
  let dropSchema: () => Promise<void>;

  beforeAll(async () => {
    const connection = databaseUrlFromEnvironment();
    admin = connectDatabase(connection);
    const created = await createTestSchema(admin);
    schema = created.schema;
    dropSchema = created.drop;
    database = connectDatabase(withSearchPath(connection, schema));
    await migrate(database);
    engine = createEngine({ database });
  });

  afterAll(async () => {
    await database?.destroy();
    await dropSchema?.();
    await admin?.destroy();
  });

  it("reads back a conversation written by a process that has exited", async () => {
    const shopperId = await createAccount(database, "returning@example.com");

    const { stdout } = await run(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", writerScript, shopperId, "Bike helmet", "Looking for a MIPS helmet."],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrlFromEnvironment(),
          DATABASE_SCHEMA: schema,
        },
      },
    );
    const { conversationId } = JSON.parse(stdout) as { conversationId: string };

    const reopened = await engine.conversations.get(shopperId, conversationId);
    expect(reopened.title).toBe("Bike helmet");
    expect(reopened.messages.map((message) => message.content)).toEqual([
      "Looking for a MIPS helmet.",
    ]);
  });
});
