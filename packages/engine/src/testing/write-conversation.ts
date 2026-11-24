/**
 * Writes a conversation through the engine and exits, so the parent test can
 * prove the data survives a real process restart rather than a reconnection.
 *
 * Usage: node --experimental-strip-types write-conversation.ts <userId> <title> <message>
 */
import { connectDatabase, withSearchPath } from "@shopping-assistant/database";
import { createEngine } from "../index.ts";

const [userId, title, content] = process.argv.slice(2);
const connection = process.env.DATABASE_URL;
const schema = process.env.DATABASE_SCHEMA;

if (!userId || !title || !content || !connection || !schema) {
  throw new Error("Expected <userId> <title> <message> and DATABASE_URL, DATABASE_SCHEMA");
}

const database = connectDatabase(withSearchPath(connection, schema));
const engine = createEngine({ database });

const conversation = await engine.conversations.create(userId, { title });
await engine.conversations.appendMessage(userId, conversation.id, { role: "user", content });

process.stdout.write(JSON.stringify({ conversationId: conversation.id }));
await database.destroy();
