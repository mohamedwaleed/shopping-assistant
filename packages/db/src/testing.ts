// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/**
 * Starts every test file from a clean schema.
 *
 * The development PostgreSQL instance is shared by the checkout and every
 * worktree, and each worktree has its own migration set. A run left behind by
 * another worktree records migrations this checkout does not have, which makes
 * `migrate.rollback` refuse to run ("the migration directory is corrupt").
 * Dropping the schema sidesteps that without touching anyone's migration files
 * or their data outside this test database.
 */
export async function resetSchema(db: Knex): Promise<void> {
  await db.raw("DROP SCHEMA IF EXISTS public CASCADE");
  await db.raw("CREATE SCHEMA public");
}

/** Clean schema, then this checkout's migrations, in order. */
export async function migrateFresh(db: Knex): Promise<void> {
  await resetSchema(db);
  await db.migrate.latest();
}
