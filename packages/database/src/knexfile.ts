import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Knex } from "knex";

const migrationsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

export function databaseUrlFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return (
    environment.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:54329/shopping_assistant_dev"
  );
}

export function knexConfig(connection: string): Knex.Config {
  return {
    client: "pg",
    connection,
    migrations: {
      directory: migrationsDirectory,
    },
  };
}
