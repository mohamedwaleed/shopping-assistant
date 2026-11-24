import knexFactory, { type Knex } from "knex";
import { databaseUrlFromEnvironment, knexConfig } from "./knexfile.ts";

export { databaseUrlFromEnvironment, knexConfig };

export type Database = Knex;

export function connectDatabase(connection: string = databaseUrlFromEnvironment()): Database {
  return knexFactory(knexConfig(connection));
}

/** Points a connection string at a different database or schema. */
export function withSearchPath(connection: string, schema: string): string {
  const url = new URL(connection);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
