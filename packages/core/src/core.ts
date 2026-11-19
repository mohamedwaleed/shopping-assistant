// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { getVariantOfferDetail, listAttributeReviews, reviewAttributeClaim, type AttributeReview, type VariantOfferDetail } from "./catalogue";
import { createAuthentication, type AuthDependencies, type Authentication } from "./auth/authentication";
import { createMailer, type Mailer, type MailerDependencies } from "./mail/mailer";
import { createEmailLinkOperations, type EmailLinkOperations } from "./auth/email-links";
import type { Result } from "./errors";
import {
  createModelRegistry,
  type ModelRegistry,
  type ModelRegistryDependencies,
} from "./models/model-registry";
import type { Principal } from "./principal";
import { createBudgetRegistry, type BudgetRegistry } from "./budgets/budget-registry";
import { createIngestion, type IngestionDependencies, type IngestedPage } from "./ingestion";

export interface ShoppingCore {
  auth: Authentication;
  mail: Mailer;
  emailLinks: EmailLinkOperations;
  models: ModelRegistry;
  budgets: BudgetRegistry;
  catalogue: {
    getVariantOfferDetail(
      principal: Principal,
      variantId: string,
    ): Promise<Result<VariantOfferDetail>>;
    ingestProductPage(principal: Principal, sourceUrl: string): Promise<Result<IngestedPage>>;
    listAttributeReviews(principal: Principal): Promise<Result<AttributeReview[]>>;
    reviewAttributeClaim(principal: Principal, claimId: string, canonicalKey: string | null): Promise<Result<void>>;
  };
}

type CoreDependencies = {
  db: Knex;
  models: Pick<ModelRegistryDependencies, "cipher" | "probe">;
} & Partial<AuthDependencies> &
  Partial<MailerDependencies> & { ingestion?: IngestionDependencies };

/** Core owns shopping operations and authorization; adapters stay thin. */
export function createShoppingCore(deps: CoreDependencies): ShoppingCore {
  const auth = createAuthentication({
    ...(deps.setupToken ? { setupToken: deps.setupToken } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    db: deps.db,
  });
  const mail = createMailer({
    db: deps.db,
    ...(deps.installationSecret ? { installationSecret: deps.installationSecret } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    auth,
    mail,
    emailLinks: createEmailLinkOperations({ db: deps.db, auth, mail, ...(deps.now ? { now: deps.now } : {}) }),
    models: createModelRegistry({
      db: deps.db,
      cipher: deps.models.cipher,
      probe: deps.models.probe,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    budgets: createBudgetRegistry({ db: deps.db }),
    catalogue: {
      getVariantOfferDetail: (principal, variantId) =>
        getVariantOfferDetail(deps.db, principal, variantId),
      ingestProductPage: createIngestion(deps.db, deps.ingestion),
      listAttributeReviews: (principal) => listAttributeReviews(deps.db, principal),
      reviewAttributeClaim: (principal, claimId, canonicalKey) => reviewAttributeClaim(deps.db, principal, claimId, canonicalKey),
    },
  };
}
