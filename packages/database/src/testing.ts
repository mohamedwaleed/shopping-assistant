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

/**
 * A Better Auth identity with no profile yet, for tests that exercise account
 * policy itself. The id is a uuid so it round-trips through the uuid columns
 * the down migration restores.
 */
export async function createIdentity(database: Database, email: string): Promise<string> {
  const [identity] = await database("user")
    .insert({
      name: email.split("@")[0] ?? email,
      email,
      createdAt: database.fn.now(),
      updatedAt: database.fn.now(),
    })
    .returning("id");
  return (identity as { id: string }).id;
}

/** A controlled test identity together with the profile it owns. */
export async function createAccount(database: Database, email: string): Promise<string> {
  const id = await createIdentity(database, email);
  await database("profiles").insert({ id, email });
  return id;
}

/** Every account an installation holds, so tests can count admins. */
export async function listAccounts(
  database: Database,
): Promise<{ email: string; role: string }[]> {
  return database("profiles").orderBy("email").select(["email", "role"]);
}
