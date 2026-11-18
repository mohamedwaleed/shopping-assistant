// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import {
  getVariantOfferDetail,
  type VariantOfferDetail,
} from "./catalogue";
import { createAuthentication, type AuthDependencies, type Authentication } from "./auth/authentication";
import type { Result } from "./errors";
import type { Principal } from "./principal";

export interface ShoppingCore {
  auth: Authentication;
  catalogue: {
    getVariantOfferDetail(
      principal: Principal,
      variantId: string,
    ): Promise<Result<VariantOfferDetail>>;
  };
}

/** Core owns shopping operations and authorization; adapters stay thin. */
export function createShoppingCore(deps: { db: Knex } & Partial<AuthDependencies>): ShoppingCore {
  return {
    auth: createAuthentication({
      ...(deps.setupToken ? { setupToken: deps.setupToken } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      db: deps.db,
    }),
    catalogue: {
      getVariantOfferDetail: (principal, variantId) =>
        getVariantOfferDetail(deps.db, principal, variantId),
    },
  };
}
