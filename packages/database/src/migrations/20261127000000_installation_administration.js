/**
 * Installation administration (#54): accounts gain an access state, the
 * installation gains the policy an admin may change, and the database itself
 * guarantees that at least one active admin always exists.
 * @param {import("knex").Knex} knex
 */
export async function up(knex) {
  // A disabled account keeps its profile, its role, and its data; only its
  // access is withdrawn. Deleting it instead would silently delete the
  // conversations it owns, which an admin has no authority over.
  await knex.schema.alterTable("profiles", (table) => {
    table.boolean("disabled").notNullable().defaultTo(false);
    table.timestamp("disabled_at", { useTz: true });
  });

  await knex.schema.alterTable("installation", (table) => {
    // The model an admin chose, or nothing while the operator's own choice
    // stands. Only ids the operator offers are accepted, by the engine.
    table.text("policy_model_id");
    // Bumped by every policy write, so a policy can be changed in place and a
    // reader can tell one revision from the next.
    table.integer("policy_revision").notNullable().defaultTo(0);
    table.timestamp("policy_updated_at", { useTz: true });
  });

  // A check constraint cannot consult other rows, so the invariant needs a
  // trigger: no transaction may commit a state with no active admin left. The
  // constraint is deferrable and checked at commit, so one transaction may
  // promote a replacement before demoting the incumbent, while two concurrent
  // transactions that would each remove the installation's last admin are
  // serialised by the deferred check.
  await knex.raw(`
    CREATE FUNCTION installation_keeps_active_admin() RETURNS trigger AS $$
    DECLARE
      active_admins integer;
    BEGIN
      -- Rows that cannot have changed the answer are not worth a count, and
      -- returning early keeps ordinary registrations free of a scan. The test
      -- is on the row as it was *and* as it is: a demotion or a disable moves
      -- an admin out of the count, so either side being an admin matters.
      IF TG_TABLE_NAME = 'profiles' THEN
        IF TG_OP = 'DELETE' AND OLD.role <> 'admin' THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'INSERT' AND NEW.role <> 'admin' THEN
          RETURN NULL;
        END IF;
        IF TG_OP = 'UPDATE' THEN
          IF NEW.role <> 'admin' AND OLD.role <> 'admin' THEN
            RETURN NULL;
          END IF;
          -- Re-enabling an admin only ever adds one.
          IF OLD.disabled AND NOT NEW.disabled THEN
            RETURN NULL;
          END IF;
        END IF;
      ELSE
        -- The installation row itself is never an admin; only its removal can
        -- change the answer, and a removed installation administers nothing.
        IF TG_OP = 'UPDATE' AND NEW IS NOT NULL THEN
          RETURN NULL;
        END IF;
      END IF;

      SELECT count(*) INTO active_admins
      FROM profiles
      WHERE role = 'admin' AND NOT disabled;
      IF active_admins = 0 THEN
        RAISE EXCEPTION 'the installation must keep an active admin'
          USING ERRCODE = 'check_violation',
                CONSTRAINT = 'installation_active_admin_required';
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `);

  await knex.raw(`
    CREATE CONSTRAINT TRIGGER profiles_keep_active_admin
      AFTER INSERT OR UPDATE OR DELETE ON profiles
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION installation_keeps_active_admin()
  `);
  // Bootstrap writes the installation row and its admin in one transaction, so
  // the installation is only required to have an admin when that transaction
  // commits.
  await knex.raw(`
    CREATE CONSTRAINT TRIGGER installation_requires_active_admin
      AFTER INSERT OR UPDATE ON installation
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION installation_keeps_active_admin()
  `);
}

/**
 * @param {import("knex").Knex} knex
 */
export async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS installation_requires_active_admin ON installation`);
  await knex.raw(`DROP TRIGGER IF EXISTS profiles_keep_active_admin ON profiles`);
  await knex.raw(`DROP FUNCTION IF EXISTS installation_keeps_active_admin()`);
  await knex.schema.alterTable("installation", (table) => {
    table.dropColumn("policy_model_id");
    table.dropColumn("policy_revision");
    table.dropColumn("policy_updated_at");
  });
  await knex.schema.alterTable("profiles", (table) => {
    table.dropColumn("disabled");
    table.dropColumn("disabled_at");
  });
}
