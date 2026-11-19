// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import {
  getVariantOfferDetail,
  type VariantOfferDetail,
} from "./catalogue";
import { createAuthentication, type AuthDependencies, type Authentication } from "./auth/authentication";
import {
  createAccountLinks,
  type AccountLinks,
} from "./auth/account-links";
import { createMailer, type Mailer, type MailerDependencies, type MailTransport } from "./mail/mailer";
import { nodemailerTransport } from "./mail/nodemailer-transport";
import type { Result } from "./errors";
import {
  createModelRegistry,
  type ModelRegistry,
  type ModelRegistryDependencies,
} from "./models/model-registry";
import type { Principal } from "./principal";

export interface ShoppingCore {
  auth: Authentication;
  /** Invitations, password recovery and email-address changes. */
  accountLinks: AccountLinks;
  mail: Mailer;
  models: ModelRegistry;
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
  /** Installation transport for account email; delivery is never mocked. */
  mailTransport?: MailTransport;
  /** Absolute base URL the delivered account links point at. */
  baseUrl?: () => string | undefined;
} & Partial<AuthDependencies> &
  Partial<MailerDependencies>;

/** Core owns shopping operations and authorization; adapters stay thin. */
export function createShoppingCore(deps: CoreDependencies): ShoppingCore {
  const mail = createMailer({
    db: deps.db,
    ...(deps.installationSecret ? { installationSecret: deps.installationSecret } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return {
    auth: createAuthentication({
      ...(deps.setupToken ? { setupToken: deps.setupToken } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      db: deps.db,
    }),
    accountLinks: createAccountLinks({
      db: deps.db,
      mail,
      transport: deps.mailTransport ?? nodemailerTransport(),
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    mail,
    models: createModelRegistry({
      db: deps.db,
      cipher: deps.models.cipher,
      probe: deps.models.probe,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    catalogue: {
      getVariantOfferDetail: (principal, variantId) =>
        getVariantOfferDetail(deps.db, principal, variantId),
    },
  };
}
