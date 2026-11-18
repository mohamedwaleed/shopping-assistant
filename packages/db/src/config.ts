// SPDX-License-Identifier: AGPL-3.0-or-later
export const DEFAULT_DATABASE_URL =
  "postgres://postgres:postgres@localhost:54329/shopping_assistant";

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:54329/shopping_assistant_test";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
