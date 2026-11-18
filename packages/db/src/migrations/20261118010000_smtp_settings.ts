// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";

// Protected installation email settings and the outcome of the last diagnostic
// delivery. The SMTP password is stored encrypted with an installation secret
// held outside the database (docs/decisions.md round five), so a database dump
// alone does not reveal it. Settings are absent until an administrator
// explicitly saves them: nothing is inferred from the environment.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("installation", (t) => {
    t.jsonb("smtp_settings");
    t.jsonb("mail_delivery");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("installation", (t) => {
    t.dropColumn("mail_delivery");
    t.dropColumn("smtp_settings");
  });
}
