// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// ChatGPT plan usage (docs/adr/0013). A provider OAuth connection belongs to a
// private workspace and is deliberately separate from application sign-in:
// there is no user or account column here, so authorizing a provider can never
// create, link or merge an application identity. Tokens are encrypted with the
// installation secret held outside PostgreSQL (docs/adr/0012), and the account
// subject is only ever shown masked. Usage-source selection and the last
// observed plan state are stored so eligibility, expiry, quota and billing
// source are reported rather than inferred.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("chatgpt_plan_connections", (t) => {
    t.uuid("workspace_id")
      .primary()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    // The ChatGPT account this connection was authorized for. `subject` is the
    // validated ID-token subject; the email is a masked hint, never an identity
    // to match an application account against.
    t.text("account_subject").notNullable();
    t.text("account_email_hint");
    t.text("client_id").notNullable();
    t.text("host_id").notNullable();
    t.text("ciphertext").notNullable();
    t.text("encryption").notNullable();
    t.text("scopes").notNullable();
    t.timestamp("expires_at", { useTz: true }).notNullable();
    // Granted plan scope present. False means the sign-in is retained but plan
    // usage stays disabled until the shopper enables it explicitly.
    t.boolean("plan_enabled").notNullable().defaultTo(false);
    t.text("status").notNullable().defaultTo("connected");
    t.text("selected_model");
    t.text("selected_model_label");
    t.text("usage_source").notNullable().defaultTo("chatgpt-plan");
    t.text("plan_state").notNullable().defaultTo("available");
    t.text("plan_reason");
    t.text("plan_message");
    t.timestamp("last_checked_at", { useTz: true });
    t.timestamp("disconnected_at", { useTz: true });
    t.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE chatgpt_plan_connections ADD CONSTRAINT chatgpt_plan_connections_status_check " +
      "CHECK (status IN ('connected', 'disconnected'))",
  );
  await knex.raw(
    "ALTER TABLE chatgpt_plan_connections ADD CONSTRAINT chatgpt_plan_connections_usage_source_check " +
      "CHECK (usage_source IN ('chatgpt-plan', 'api-key'))",
  );
  await knex.raw(
    "ALTER TABLE chatgpt_plan_connections ADD CONSTRAINT chatgpt_plan_connections_plan_state_check " +
      "CHECK (plan_state IN ('available', 'paused'))",
  );
  await knex.raw(
    "ALTER TABLE chatgpt_plan_connections ADD CONSTRAINT chatgpt_plan_connections_plan_reason_check " +
      "CHECK (plan_reason IS NULL OR plan_reason IN " +
      "('usage-limit', 'usage-unavailable', 'not-eligible', 'unsupported-capability', 'expired'))",
  );

  // Observed plan outcomes, one row per state change. This is the usage-source
  // trail the settings and chat screens read: an exhausted or ineligible plan
  // pauses plan usage visibly and never switches billing on its own.
  await knex.schema.createTable("chatgpt_plan_usage_events", (t) => {
    t.increments("id").primary();
    t.uuid("workspace_id")
      .notNullable()
      .references("id")
      .inTable("workspaces")
      .onDelete("CASCADE");
    t.text("kind").notNullable();
    t.text("reason");
    t.text("message");
    t.timestamp("observed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    "ALTER TABLE chatgpt_plan_usage_events ADD CONSTRAINT chatgpt_plan_usage_events_kind_check " +
      "CHECK (kind IN ('usage-limit-exceeded', 'usage-unavailable', 'not-eligible', " +
      "'unsupported-capability', 'request-failed', 'completed', 'refreshed', 'disconnected'))",
  );
  await knex.raw(
    "CREATE INDEX chatgpt_plan_usage_events_workspace_observed_idx " +
      "ON chatgpt_plan_usage_events (workspace_id, observed_at DESC)",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema
    .dropTableIfExists("chatgpt_plan_usage_events")
    .dropTableIfExists("chatgpt_plan_connections");
}
