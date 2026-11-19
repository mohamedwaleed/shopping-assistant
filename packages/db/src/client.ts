// SPDX-License-Identifier: AGPL-3.0-or-later
import knex, { type Knex } from "knex";
import * as initialCatalogue from "./migrations/20261116000000_initial_catalogue";
import * as identityAndWorkspaces from "./migrations/20261117000000_identity_and_workspaces";
import * as smtpSettings from "./migrations/20261118010000_smtp_settings";
import * as modelRegistry from "./migrations/20261118030000_model_registry";
import * as pageIngestion from "./migrations/2026111900040_page_ingestion";

interface MigrationModule {
  up: (db: Knex) => Promise<void>;
  down: (db: Knex) => Promise<void>;
}

// Order is schema ordering: migrations apply in the array sequence.
const ORDERED_MIGRATIONS: ReadonlyArray<[string, MigrationModule]> = [
  ["20261116000000_initial_catalogue", initialCatalogue],
  ["20261117000000_identity_and_workspaces", identityAndWorkspaces],
  ["20261118010000_smtp_settings", smtpSettings],
  ["20261118030000_model_registry", modelRegistry],
  ["2026111900040_page_ingestion", pageIngestion],
];

/** One Knex instance per process; callers own pool lifecycle via destroy(). */
export function createDb(connection: string): Knex {
  return knex({
    client: "pg",
    connection,
    migrations: {
      migrationSource: {
        getMigrations: () =>
          Promise.resolve(ORDERED_MIGRATIONS.map(([name]) => name)),
        getMigrationName: (name: string) => name,
        getMigration: (name: unknown) => {
          const entry = ORDERED_MIGRATIONS.find(([n]) => n === name);
          if (!entry) throw new Error(`unknown migration ${String(name)}`);
          return Promise.resolve(entry[1]);
        },
      },
    },
  });
}
