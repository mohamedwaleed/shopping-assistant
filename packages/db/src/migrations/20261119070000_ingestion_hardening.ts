// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/**
 * Per-source retrieval state, so a blocked or broken source is visible instead
 * of silently repeating a failing request. One row per host, written by the
 * ingestion path only; there is no fixture or seed data here.
 *
 * A failed check updates the failure columns and never touches the success
 * columns, so a bad fetch cannot make a source look healthy.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ingestion_sources", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("host").notNullable().unique();
    t.text("retailer_name");
    t.timestamp("last_success_at", { useTz: true });
    t.timestamp("last_failure_at", { useTz: true });
    t.text("last_failure_classification");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE ingestion_sources ADD CONSTRAINT ingestion_sources_classification_check " +
      "CHECK (last_failure_classification IS NULL OR last_failure_classification IN " +
      "('redirect', 'challenge', 'http', 'network', 'size', 'timeout', 'extraction', 'identity'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("ingestion_sources");
}
