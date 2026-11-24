import { randomUUID } from "node:crypto";
import type { Database } from "./index.ts";

/**
 * Creates an isolated schema and migrates it, so test files never share state
 * and can run in parallel against one PostgreSQL server.
 */
export async function createTestSchema(base: Database): Promise<{
  schema: string;
  drop: () => Promise<void>;
}> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await base.raw(`CREATE SCHEMA ??`, [schema]);
  return {
    schema,
    drop: async () => {
      await base.raw(`DROP SCHEMA IF EXISTS ?? CASCADE`, [schema]);
    },
  };
}

export async function migrate(database: Database): Promise<void> {
  await database.migrate.latest();
}

/** Controlled test identity; account management arrives with ticket #52. */
export async function createAccount(
  database: Database,
  email: string,
): Promise<string> {
  const [row] = await database("users").insert({ email }).returning("id");
  return (row as { id: string }).id;
}
