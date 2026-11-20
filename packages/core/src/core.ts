// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { getVariantOfferDetail, listAttributeReviews, reviewAttributeClaim, type AttributeReview, type VariantOfferDetail } from "./catalogue";
import {
  searchCatalogue,
  type CatalogueSearchQuery,
  type CatalogueSearchResponse,
} from "./catalogue-search";
import { createAuthentication, type AuthDependencies, type Authentication } from "./auth/authentication";
import { createMailer, type Mailer, type MailerDependencies } from "./mail/mailer";
import { createEmailLinkOperations, type EmailLinkOperations } from "./auth/email-links";
import { err, ok, type Result } from "./errors";
import {
  createModelRegistry,
  type ModelRegistry,
  type ModelRegistryDependencies,
} from "./models/model-registry";
import type { Principal } from "./principal";
import { isAuthorized } from "./principal";
import { createBudgetRegistry, type BudgetRegistry } from "./budgets/budget-registry";
import { createIngestion, type IngestionDependencies, type IngestedPage } from "./ingestion";
import {
  createSourceCoverage,
  type SourceCoverage,
  type SourceCoverageService,
} from "./ingestion/source-coverage";
import {
  createSourceReader,
  type HostCoordination,
  type SourceReader,
} from "./ingestion/source-reader";
import type { ModelExtractor } from "./ingestion/readable-extraction";
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
    search(
      principal: Principal,
      query: CatalogueSearchQuery,
    ): Promise<Result<CatalogueSearchResponse>>;
    getVariantOfferDetail(
      principal: Principal,
      variantId: string,
    ): Promise<Result<VariantOfferDetail>>;
    ingestProductPage(principal: Principal, sourceUrl: string): Promise<Result<IngestedPage>>;
    listAttributeReviews(principal: Principal): Promise<Result<AttributeReview[]>>;
    reviewAttributeClaim(principal: Principal, claimId: string, canonicalKey: string | null): Promise<Result<void>>;
  };
  /** Source reliability: adapters, coverage, access blocks and host policy. */
  sources: {
    coverage(principal: Principal, host: string): Promise<Result<SourceCoverage>>;
    recordAccessBlock(principal: Principal, input: { url: string; reason: "robots" | "terms"; signal: string }): Promise<Result<void>>;
    coordination(principal: Principal, host: string): Promise<Result<HostCoordination>>;
    saveCoordination(principal: Principal, host: string, input: HostCoordination): Promise<Result<HostCoordination>>;
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
  Partial<MailerDependencies> & { ingestion?: IngestionDependencies } & {
    /** The extraction model adapter; absent means no model extraction. */
    extraction?: { extractor?: ModelExtractor };
    /** The installation secret, used to decrypt the extraction credential. */
    installationSecret?: string;
  };

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
  const now = deps.now ?? (() => new Date());
  const modelRegistry = createModelRegistry({
    db: deps.db,
    cipher: deps.models.cipher,
    probe: deps.models.probe,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const reader: SourceReader = createSourceReader({
    db: deps.db,
    now,
    // Retrieval bounds belong to the ingestion fetch helper; the source reader
    // only decides when to call it.
    retrieve: deps.ingestion?.fetch ?? ((url: string) => fetch(url)),
  });
  const sources: SourceCoverageService = createSourceCoverage({
    db: deps.db,
    reader,
    ...(deps.extraction?.extractor ? { extractor: deps.extraction.extractor } : {}),
    ...(deps.extraction?.extractor ? { resolveExtractionModel: () => modelRegistry.resolveExtractionModel() } : {}),
    now,
  });
  return {
    auth,
    mail,
    emailLinks: createEmailLinkOperations({ db: deps.db, auth, mail, ...(deps.now ? { now: deps.now } : {}) }),
    models: modelRegistry,
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
      search: (principal, query) => searchCatalogue(deps.db, principal, query),
      getVariantOfferDetail: (principal, variantId) =>
        getVariantOfferDetail(deps.db, principal, variantId),
      ingestProductPage: createIngestion(deps.db, { ...deps.ingestion, coverage: sources }),
      listAttributeReviews: (principal) => listAttributeReviews(deps.db, principal),
      reviewAttributeClaim: (principal, claimId, canonicalKey) => reviewAttributeClaim(deps.db, principal, claimId, canonicalKey),
    },
    sources: {
      coverage: (principal, host) => sources.read(principal, host),
      recordAccessBlock: async (principal, input) => {
        // Declaring a source restricted is an operator decision about the whole
        // installation, not something an individual ingest request decides.
        if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
        if (input.reason !== "robots" && input.reason !== "terms") {
          return err({ kind: "invalid-input", field: "reason", message: "reason must be robots or terms" });
        }
        let url: URL;
        try {
          url = new URL(input.url);
        } catch {
          return err({ kind: "invalid-input", field: "url", message: "url must be an absolute URL" });
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          return err({ kind: "invalid-input", field: "url", message: "url must be an absolute URL" });
        }
        await reader.recordBlock(input);
        return ok(undefined);
      },
      coordination: async (principal, host) => {
        if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
        return ok(await reader.coordination(host));
      },
      saveCoordination: async (principal, host, input) => {
        if (!isAuthorized(principal, "installation.manage")) return err({ kind: "forbidden", capability: "installation.manage" });
        return reader.saveCoordination(host, input);
      },
    },
  };
}
