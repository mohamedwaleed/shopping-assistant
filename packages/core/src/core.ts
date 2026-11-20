// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { getVariantOfferDetail, listAttributeReviews, reviewAttributeClaim, type AttributeReview, type VariantOfferDetail } from "./catalogue";
import { createAuthentication, type AuthDependencies, type Authentication } from "./auth/authentication";
import { createMailer, type Mailer, type MailerDependencies } from "./mail/mailer";
import { createEmailLinkOperations, type EmailLinkOperations } from "./auth/email-links";
import { err, type Result } from "./errors";
import {
  createModelRegistry,
  type ModelRegistry,
  type ModelRegistryDependencies,
} from "./models/model-registry";
import type { Principal } from "./principal";
import { createBudgetRegistry, type BudgetRegistry } from "./budgets/budget-registry";
import { createIngestion, type IngestionDependencies, type IngestedPage } from "./ingestion";
import { createChatSessions, type ChatSessions } from "./chat";
import {
  createChatGPTPlanConnections,
  type ChatGPTPlanConnections,
  type ChatGPTPlanDependencies,
} from "./models/chatgpt-plan";

export interface ShoppingCore {
  auth: Authentication;
  mail: Mailer;
  emailLinks: EmailLinkOperations;
  models: ModelRegistry;
  /** Provider OAuth for ChatGPT plan usage; separate from application sign-in. */
  chatgptPlan: ChatGPTPlanConnections;
  budgets: BudgetRegistry;
  chat: ChatSessions;
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
  /** The AI SDK adapter that exercises a ChatGPT plan shopping tool step. */
  planExercise?: ChatGPTPlanDependencies["exercise"];
  planOAuth?: Pick<
    ChatGPTPlanDependencies,
    "authorizeUrl" | "tokenUrl" | "redirectUri" | "agentName" | "hostId"
  >;
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
    chatgptPlan: createChatGPTPlanConnections({
      db: deps.db,
      cipher: deps.models.cipher,
      // Without an adapter no plan request is attempted: the core refuses the
      // exercise as a configuration error instead of inventing a model call.
      exercise: deps.planExercise ?? (async () => err({ kind: "chatgpt-plan-request-failed", code: "no-plan-adapter", status: 503 })),
      ...(deps.planOAuth ?? {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    chat: createChatSessions({ db: deps.db }),
    catalogue: {
      getVariantOfferDetail: (principal, variantId) =>
        getVariantOfferDetail(deps.db, principal, variantId),
      ingestProductPage: createIngestion(deps.db, deps.ingestion),
      listAttributeReviews: (principal) => listAttributeReviews(deps.db, principal),
      reviewAttributeClaim: (principal, claimId, canonicalKey) => reviewAttributeClaim(deps.db, principal, claimId, canonicalKey),
    },
  };
}
