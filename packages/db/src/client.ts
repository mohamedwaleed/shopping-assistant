// SPDX-License-Identifier: AGPL-3.0-or-later
import knex, { type Knex } from "knex";
import * as initialCatalogue from "./migrations/20261116000000_initial_catalogue";
import * as identityAndWorkspaces from "./migrations/20261117000000_identity_and_workspaces";
import * as smtpSettings from "./migrations/20261118010000_smtp_settings";
import * as modelRegistry from "./migrations/20261118030000_model_registry";
import * as providerBudgets from "./migrations/20261119003000_provider_budgets";
import * as pageIngestion from "./migrations/20261119010000_page_ingestion";
import * as authenticatorTwoFactor from "./migrations/20261119020000_authenticator_two_factor";
import * as attributeReview from "./migrations/20261119030000_attribute_review";
import * as shoppingChat from "./migrations/20261119040000_shopping_chat";
import * as planUsage from "./migrations/20261119090000_plan_usage";

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
  ["20261119003000_provider_budgets", providerBudgets],
  ["20261119010000_page_ingestion", pageIngestion],
  ["20261119020000_authenticator_two_factor", authenticatorTwoFactor],
  ["20261119030000_attribute_review", attributeReview],
  ["20261119040000_shopping_chat", shoppingChat],
  ["20261119090000_plan_usage", planUsage],
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
