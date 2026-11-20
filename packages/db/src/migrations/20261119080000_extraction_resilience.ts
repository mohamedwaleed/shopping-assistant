// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

/**
 * Source reliability is public catalogue data: it records how a permitted source
 * behaved, never a shopper URL or prompt. Good observations are kept even when a
 * later layout change breaks extraction, so nothing here overwrites price or
 * claim history.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("source_host_policies", (t) => {
    t.text("host").primary();
    t.integer("max_concurrent").notNullable().defaultTo(1);
    t.integer("minimum_interval_ms").notNullable().defaultTo(0);
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE source_host_policies ADD CONSTRAINT source_host_policies_bounds_check " +
      "CHECK (max_concurrent BETWEEN 1 AND 8 AND minimum_interval_ms BETWEEN 0 AND 60000)",
  );

  await knex.schema.createTable("source_requests", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("url").notNullable().unique();
    t.text("host").notNullable();
    t.text("state").notNullable();
    t.text("outcome").notNullable();
    t.text("cache_context").notNullable();
    t.text("adapter_id");
    t.text("adapter_version");
    t.integer("attempts").notNullable().defaultTo(0);
    t.timestamp("fetched_at", { useTz: true });
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.timestamp("completed_at", { useTz: true });
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(["host", "created_at"], "source_requests_host_created_idx");
  });
  await knex.raw(
    "ALTER TABLE source_requests ADD CONSTRAINT source_requests_state_check " +
      "CHECK (state IN ('in_flight', 'complete'))",
  );

  await knex.schema.createTable("source_access_blocks", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.text("host").notNullable();
    t.text("url").notNullable();
    t.text("reason").notNullable();
    t.text("signal").notNullable();
    t.integer("status_code");
    t.timestamp("observed_at", { useTz: true }).notNullable();
    t.timestamp("retry_after_at", { useTz: true });
    t.index(["host", "observed_at"], "source_access_blocks_host_time_idx");
  });
  await knex.raw(
    "ALTER TABLE source_access_blocks ADD CONSTRAINT source_access_blocks_reason_check " +
      "CHECK (reason IN ('robots', 'terms', 'challenge', 'rate-limited', 'forbidden'))",
  );

  await knex.schema.createTable("source_adapter_state", (t) => {
    t.text("host").primary();
    t.text("adapter_id").notNullable();
    t.text("adapter_version").notNullable();
    t.jsonb("required_fields").notNullable();
    t.text("field_coverage").notNullable();
    t.timestamp("last_success_at", { useTz: true });
    t.timestamp("last_failure_at", { useTz: true });
    t.text("last_failure_kind");
    t.timestamp("cache_expires_at", { useTz: true });
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE source_adapter_state ADD CONSTRAINT source_adapter_state_coverage_check " +
      "CHECK (field_coverage IN ('complete', 'partial', 'none'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("source_adapter_state")
    .dropTableIfExists("source_access_blocks")
    .dropTableIfExists("source_requests")
    .dropTableIfExists("source_host_policies");
}
