// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import {
  getVariantOfferDetail,
  type VariantOfferDetail,
} from "./catalogue";
import { createAuthentication, type AuthDependencies, type Authentication } from "./auth/authentication";
import { createMailer, type Mailer, type MailerDependencies } from "./mail/mailer";
import type { Result } from "./errors";
import { createModelRegistry, type ModelRegistry, type ModelRegistryDependencies } from "./models/model-registry";
import { createBudgets } from "./models/budgets";
import type { Budgets } from "./models/budget-types";
import type { Principal } from "./principal";

export interface ShoppingCore {
  auth: Authentication;
  mail: Mailer;
  models: ModelRegistry;
  budgets: Budgets;
  catalogue: {
    getVariantOfferDetail(
      principal: Principal,
      variantId: string,
    ): Promise<Result<VariantOfferDetail>>;
  };
}

type CoreDependencies = {
  db: Knex;
  models: Pick<ModelRegistryDependencies, "cipher" | "probe">;
} & Partial<AuthDependencies> &
  Partial<MailerDependencies>;

/** Core owns shopping operations and authorization; adapters stay thin. */
export function createShoppingCore(deps: CoreDependencies): ShoppingCore {
  const models = createModelRegistry({
    db: deps.db,
    cipher: deps.models.cipher,
    probe: deps.models.probe,
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    auth: createAuthentication({
      ...(deps.setupToken ? { setupToken: deps.setupToken } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      db: deps.db,
    }),
    mail: createMailer({
      db: deps.db,
      ...(deps.installationSecret ? { installationSecret: deps.installationSecret } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    models,
    budgets: createBudgets({
      db: deps.db,
      resolveModel: (principal) => models.resolve(principal),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    catalogue: {
      getVariantOfferDetail: (principal, variantId) =>
        getVariantOfferDetail(deps.db, principal, variantId),
    },
  };
}
