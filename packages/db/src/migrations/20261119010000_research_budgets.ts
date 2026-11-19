// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// Research and monitoring budgets. An allowance is a windowed pool of provider
// work: interactive research and background monitoring are separate rows so one
// can never consume the other. Every provider call is reserved against exactly
// one allowance, and the reservation is a row rather than a counter so that a
// concurrent caller can be serialized with SELECT ... FOR UPDATE (docs/adr/0013).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("budget_allowances", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    // 'installation' rows are the ceilings; 'workspace' rows are overrides that
    // are clamped to them and never accumulate with them.
    t.text("scope").notNullable();
    // Null for an installation row; the owning workspace otherwise.
    t.uuid("workspace_id").references("id").inTable("workspaces").onDelete("CASCADE");
    t.text("pool").notNullable();
    t.integer("max_calls").notNullable();
    t.integer("max_tokens").notNullable();
    t.integer("max_cents").notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE budget_allowances ADD CONSTRAINT budget_allowances_scope_check " +
      "CHECK (scope IN ('installation', 'workspace'))",
  );
  await knex.raw(
    "ALTER TABLE budget_allowances ADD CONSTRAINT budget_allowances_pool_check " +
      "CHECK (pool IN ('interactive', 'background'))",
  );
  await knex.raw(
    "ALTER TABLE budget_allowances ADD CONSTRAINT budget_allowances_limits_check " +
      "CHECK (max_calls >= 0 AND max_tokens >= 0 AND max_cents >= 0)",
  );
  // A scope is either the installation singleton or one workspace, never both.
  await knex.raw(
    "ALTER TABLE budget_allowances ADD CONSTRAINT budget_allowances_owner_check " +
      "CHECK ((scope = 'installation' AND workspace_id IS NULL) OR " +
      "(scope = 'workspace' AND workspace_id IS NOT NULL))",
  );
  await knex.raw(
    "CREATE UNIQUE INDEX budget_allowances_installation_unique " +
      "ON budget_allowances (pool) WHERE scope = 'installation'",
  );
  await knex.raw(
    "CREATE UNIQUE INDEX budget_allowances_workspace_unique " +
      "ON budget_allowances (workspace_id, pool) WHERE scope = 'workspace'",
  );

  // Each row is one windowed allowance for one workspace and pool. The window
  // anchor is fixed when the row is created, so every caller reads the same
  // period instead of rolling its own.
  await knex.schema.createTable("budget_periods", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("workspace_id")
      .notNullable()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    t.text("pool").notNullable();
    t.timestamp("window_started_at", { useTz: true }).notNullable();
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE budget_periods ADD CONSTRAINT budget_periods_pool_check " +
      "CHECK (pool IN ('interactive', 'background'))",
  );
  await knex.raw(
    "CREATE UNIQUE INDEX budget_periods_window_unique ON budget_periods (workspace_id, pool, window_started_at)",
  );

  // One reservation per provider call. The consumed columns are denormalized
  // from the allowance so that two allowances over the same window can never
  // both hand out the same unit of work.
  await knex.schema.createTable("budget_reservations", (t) => {
    t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    t.uuid("period_id")
      .notNullable()
      .references("id")
      .inTable("budget_periods")
      .onDelete("CASCADE");
    t.text("pool").notNullable();
    t.text("usage_source").notNullable();
    t.integer("reserved_calls").notNullable();
    t.integer("reserved_tokens").notNullable();
    t.integer("reserved_cents").notNullable();
    t.integer("actual_tokens");
    t.integer("actual_cents");
    t.text("status").notNullable();
    t.integer("attempt").notNullable().defaultTo(1);
    // Which retryable failure this reservation is retrying; a retry is charged
    // twice only when the provider was already contacted.
    t.text("retry_of");
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("settled_at", { useTz: true });
    t.timestamp("expires_at", { useTz: true }).notNullable();
    t.index(["period_id", "status"], "budget_reservations_period_status_idx");
    t.index(["created_at"], "budget_reservations_created_at_idx");
  });
  await knex.raw(
    "ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_status_check " +
      "CHECK (status IN ('reserved', 'settled', 'released'))",
  );
  await knex.raw(
    "ALTER TABLE budget_reservations ADD CONSTRAINT budget_reservations_usage_source_check " +
    "CHECK (usage_source IN ('installation', 'workspace'))",
  );

  // Workspace overrides, but only where the administrator allows them: without
  // a row a workspace cannot raise or move its own allowance.
  await knex.schema.createTable("workspace_budget_permissions", (t) => {
    t.uuid("workspace_id")
      .primary()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    t.boolean("may_override").notNullable().defaultTo(false);
    t.boolean("may_allow_paid_fallback").notNullable().defaultTo(false);
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Consent to spend a workspace's own key on background work. Explicit and
  // revocable: absent means background work uses the installation account or
  // pauses, never the personal key.
  await knex.schema.createTable("workspace_personal_key_consents", (t) => {
    t.uuid("workspace_id")
      .primary()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    t.boolean("background_allowed").notNullable().defaultTo(false);
    t.text("consented_by_user_id").references("id").inTable("user").onDelete("SET NULL");
    t.timestamp("consented_at", { useTz: true });
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("workspace_personal_key_consents")
    .dropTableIfExists("workspace_budget_permissions")
    .dropTableIfExists("budget_reservations")
    .dropTableIfExists("budget_periods")
    .dropTableIfExists("budget_allowances");
}
