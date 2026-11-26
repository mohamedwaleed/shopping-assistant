/**
 * Bounded research and usage accounting (#55). A run is the unit a shopper
 * starts, pauses, stops, and continues; `usage_events` is the append-only
 * ledger behind every limit, so what was spent is derived from records that are
 * never rewritten rather than from counters that a crash or a race could
 * corrupt.
 *
 * Money is stored in cents as a `numeric` without a scale, so an estimate can
 * carry a fraction of a cent and still be summed exactly; a floating-point
 * column would make two runs settle to amounts that do not add up.
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  // The limits an admin chose. Nullable so that an absent value keeps the
  // application's default, exactly as an absent model choice keeps the
  // operator's; the environment ceiling is applied on read, never stored.
  await knex.schema.alterTable("installation", (table) => {
    table.decimal("research_run_target_cents", null);
    table.decimal("research_conversation_ceiling_cents", null);
    table.decimal("research_daily_ceiling_cents", null);
    table.integer("research_call_limit");
    table.integer("research_time_limit_ms");
    table.timestamp("research_updated_at", { useTz: true });
  });

  await knex.raw(`
    CREATE TYPE research_run_state AS ENUM ('running', 'paused', 'stopped', 'completed')
  `);

  await knex.schema.createTable("research_runs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("conversation_id")
      .notNullable()
      .references("id")
      .inTable("conversations")
      .onDelete("CASCADE");
    // Denormalised from the conversation so the daily ceiling is one indexed
    // read and cannot be defeated by joining the wrong owner.
    table
      .text("user_id")
      .notNullable()
      .references("id")
      .inTable("profiles")
      .onDelete("CASCADE");
    table.specificType("state", "research_run_state").notNullable().defaultTo("running");
    // Why the run stopped or paused, in the operator's words. Null while a run
    // has never been paused.
    table.text("pause_reason");
    table.timestamp("started_at", { useTz: true }).notNullable();
    // When the shopper stopped it or the allowance ended it; null while the run
    // may still do work.
    table.timestamp("ended_at", { useTz: true });
    table.timestamp("updated_at", { useTz: true }).notNullable();
    // The limits in force for this run, copied at start so that a later policy
    // change cannot retroactively rewrite what an earlier run was allowed.
    table.decimal("run_target_cents", null).notNullable();
    table.decimal("conversation_ceiling_cents", null).notNullable();
    table.decimal("daily_ceiling_cents", null).notNullable();
    table.integer("call_limit").notNullable();
    table.integer("time_limit_ms").notNullable();
    // Time already spent working, banked whenever the run pauses or stops, so
    // the time a shopper spends away from a paused run is not charged to it.
    table.bigInteger("elapsed_ms").notNullable().defaultTo(0);
    // When the current stretch of work began; null while the run is not
    // working, which is what stops its clock while it is paused.
    table.timestamp("resumed_at", { useTz: true });
    // The results already collected. A pause or a stop keeps this: what was
    // paid for stays with the shopper.
    table.integer("results_retained").notNullable().defaultTo(0);
    // Set when any settled or reserved call had no known price, so a total is
    // never presented as complete when it is not.
    table.boolean("cost_incomplete").notNullable().defaultTo(false);
    table.index(["conversation_id", "started_at"], "research_runs_conversation_started_index");
    table.index(["user_id", "started_at"], "research_runs_user_started_index");
  });

  // A run may be started, paused, stopped, and continued many times, so its
  // history is the ledger of events rather than a column that only keeps the
  // last state.
  await knex.raw(`
    CREATE TYPE research_run_event AS ENUM ('start', 'pause', 'resume', 'stop', 'complete')
  `);

  await knex.schema.createTable("research_run_events", (table) => {
    table.bigIncrements("id").notNullable();
    table
      .uuid("run_id")
      .notNullable()
      .references("id")
      .inTable("research_runs")
      .onDelete("CASCADE");
    table.specificType("kind", "research_run_event").notNullable();
    table.text("reason");
    table.timestamp("created_at", { useTz: true }).notNullable();
    table.index(["run_id", "id"], "research_run_events_run_id_id_index");
  });

  await knex.raw(`CREATE TYPE usage_event_kind AS ENUM ('reserve', 'settle', 'release')`);

  // What a call is for, so an operator can see where the money went without
  // reading anything the shopper said.
  await knex.raw(
    `CREATE TYPE usage_call_kind AS ENUM ('model', 'retrieval', 'retry', 'fallback')`,
  );

  await knex.schema.createTable("usage_events", (table) => {
    table.bigIncrements("id").notNullable();
    table
      .uuid("run_id")
      .notNullable()
      .references("id")
      .inTable("research_runs")
      .onDelete("CASCADE");
    // The run's owner and conversation, copied so aggregates never need a join
    // and cannot drift from the run they were copied from.
    table.text("user_id").notNullable();
    table.uuid("conversation_id").notNullable();
    table.specificType("kind", "usage_event_kind").notNullable();
    // The call this reservation settles or releases. Null on a reservation,
    // which is itself the start of a call; the id it refers to is a `bigint`,
    // so the reference is stored in the same form.
    table.bigInteger("reservation_id");
    // Generated by the caller for a reservation and carried through to its
    // settlement, so a retried settlement cannot be counted twice.
    table.uuid("reference");
    table.specificType("call_kind", "usage_call_kind").notNullable();
    // The conservative estimate, held from the reservation until the call is
    // settled or released.
    table.decimal("estimated_cents", null).notNullable().defaultTo(0);
    // What the call actually cost, once it is known; null while it is reserved
    // and null when the price was never known.
    table.decimal("actual_cents", null);
    // Whether the price of this call was known at all.
    table.boolean("priced").notNullable().defaultTo(true);
    table.integer("calls").notNullable().defaultTo(0);
    table.integer("duration_ms").notNullable().defaultTo(0);
    table.timestamp("created_at", { useTz: true }).notNullable();
    table.index(["run_id", "id"], "usage_events_run_id_id_index");
    table.index(["user_id", "created_at"], "usage_events_user_id_created_at_index");
    table.index(
      ["conversation_id", "created_at"],
      "usage_events_conversation_id_created_at_index",
    );
  });

  // The ledger is the record of what was spent, so it is append-only: a limit
  // that could be reached by editing history would not be a limit.
  await knex.raw(`
    CREATE FUNCTION usage_events_are_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'usage events cannot be changed once written'
        USING ERRCODE = 'restrict_violation';
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw(`
    CREATE TRIGGER usage_events_append_only
      BEFORE UPDATE OR DELETE ON usage_events
      FOR EACH ROW EXECUTE FUNCTION usage_events_are_append_only()
  `);

  // Whatever the application believes, no settled call can be recorded without
  // the reservation it settles: that pairing is what makes the ledger add up.
  await knex.raw(`
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_reservation_required
      CHECK (
        (kind = 'reserve' AND reservation_id IS NULL)
        OR (kind <> 'reserve' AND reservation_id IS NOT NULL)
      )
  `);

  // A reservation and its settlement (or release) are written in one
  // transaction, so both exist or neither does; the deferred check therefore
  // only ever sees a complete pair. Stating it here means a settled call whose
  // reservation was never written is refused by the database itself.
  await knex.raw(`
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_reservation_exists
      FOREIGN KEY (reservation_id) REFERENCES usage_events (id)
      DEFERRABLE INITIALLY DEFERRED
  `);
  // One settlement or release per reservation, and one reservation per
  // reference: a retried request cannot buy the same call twice. The reference
  // is required by the engine for every reservation, so a null one is refused
  // here rather than quietly escaping the uniqueness the ledger relies on.
  await knex.raw(`
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_reference_required
      CHECK (kind <> 'reserve' OR reference IS NOT NULL)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX usage_events_reference_kind_unique
      ON usage_events (reference, kind)
      WHERE kind = 'reserve'
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX usage_events_reservation_kind_unique
      ON usage_events (reservation_id, kind)
      WHERE kind <> 'reserve'
  `);
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists("usage_events");
  await knex.raw(`DROP TYPE IF EXISTS usage_call_kind`);
  await knex.raw(`DROP TYPE IF EXISTS usage_event_kind`);
  await knex.raw(`DROP FUNCTION IF EXISTS usage_events_are_append_only()`);
  await knex.schema.dropTableIfExists("research_run_events");
  await knex.raw(`DROP TYPE IF EXISTS research_run_event`);
  await knex.schema.dropTableIfExists("research_runs");
  await knex.raw(`DROP TYPE IF EXISTS research_run_state`);
  await knex.schema.alterTable("installation", (table) => {
    table.dropColumn("research_run_target_cents");
    table.dropColumn("research_conversation_ceiling_cents");
    table.dropColumn("research_daily_ceiling_cents");
    table.dropColumn("research_call_limit");
    table.dropColumn("research_time_limit_ms");
    table.dropColumn("research_updated_at");
  });
}
