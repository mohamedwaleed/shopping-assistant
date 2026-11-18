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
        // The library issues a session as a side effect of checking a
        // password. The transport signs in separately and keeps only that
        // session, so the row this check just created is removed again: it is
        // the newest session of that user, and exactly one row matches.
        const result = await auth.api.signInEmail({
          body: { email, password },
        });
        const userId = result?.user?.id;
        if (!userId) return null;
        const created = await db("session")
          .where({ user_id: userId })
          .max("created_at as newest")
          .first();
        if (created?.newest) {
          await db("session").where({ user_id: userId, created_at: created.newest }).delete();
        }
        return { userId };
      } catch {
        return null;
      }
    },
  };
}
