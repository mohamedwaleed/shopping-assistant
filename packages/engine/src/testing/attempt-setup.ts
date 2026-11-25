/**
 * Attempts bootstrap through the engine and exits, so the parent test can prove
 * setup stays closed across a real process restart rather than a reconnection.
 *
 * Usage: node --experimental-strip-types attempt-setup.ts <email>
 */
import { connectDatabase, withSearchPath } from "@shopping-assistant/database";
import { createEngine, SetupClosedError } from "../index.ts";
import { createFakeIdentityStore } from "./fake-identity-store.ts";

const [email] = process.argv.slice(2);
const connection = process.env.DATABASE_URL;
const schema = process.env.DATABASE_SCHEMA;
const setupToken = process.env.SETUP_TOKEN;

if (!email || !connection || !schema || !setupToken) {
  throw new Error("Expected <email> and DATABASE_URL, DATABASE_SCHEMA, SETUP_TOKEN");
}

const database = connectDatabase(withSearchPath(connection, schema));
const engine = createEngine({ database, setupToken, identity: createFakeIdentityStore() });

const outcome = await engine.setup
  .complete({ setupToken, email, password: "correct-horse-battery-staple" })
  .then(() => "created")
  .catch((error: unknown) => (error instanceof SetupClosedError ? "closed" : "unexpected"));

process.stdout.write(JSON.stringify({ outcome }));
await database.destroy();
