// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import type { AccountProvisioner } from "@shopping/core";
import type { ShoppingAuth } from "./server";

/**
 * Adapter between core authentication and Better Auth's credential endpoints.
 * Better Auth hashes passwords, creates the credential account and issues
 * sessions; core still decides whether the resulting identity is admitted.
 */
export function createAccountProvisioner(auth: ShoppingAuth, db: Knex): AccountProvisioner {
  return {
    async createCredentialAccount({ name, email, password }) {
      const result = await auth.api.signUpEmail({
        body: { name, email, password },
      });
      if (!result?.user?.id) throw new Error("identity library did not create the account");
      return { userId: result.user.id };
    },

    async deleteIdentity(userId) {
      await db("user").where({ id: userId }).delete();
    },

    async verifyCredentials({ email, password }) {
      try {
        const result = await auth.api.signInEmail({
          body: { email, password },
        });
        return result?.user?.id ? { userId: result.user.id } : null;
      } catch {
        return null;
      }
    },
  };
}
