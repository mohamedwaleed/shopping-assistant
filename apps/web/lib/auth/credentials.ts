// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import type { CredentialChanger } from "@shopping/core";
import type { ShoppingAuth } from "./server";

export interface CredentialChangerOptions {
  /** Session cookie header value presented by the caller's request. */
  cookie: string | null;
}

/**
 * Adapter between core's credential authorization and Better Auth. Core
 * decides who may change a password and when the change is recent enough; the
 * library verifies the current password, hashes the new one and re-reads the
 * stored session, so a session revoked in between cannot complete the change.
 * An email change reaches this adapter only after the new address confirmed
 * the expiring link, and core has already revoked the old sessions.
 */
export function createCredentialChanger(
  auth: ShoppingAuth,
  db: Knex,
  options: CredentialChangerOptions,
): CredentialChanger {
  return {
    async changePassword({ userId, currentPassword, newPassword, sessionId }) {
      const session = await db("session").where({ id: sessionId, user_id: userId }).first();
      if (!session) throw new Error("session is no longer stored");
      if (!options.cookie) throw new Error("no session cookie was presented");

      // The library re-checks the stored session and the current password, so
      // the change is refused if either moved between core's checks and here.
      // A wrong password is reported as a credential failure, not a crash.
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword,
          revokeOtherSessions: false,
        },
        headers: new Headers({ cookie: options.cookie }),
        asResponse: false,
      });
    },

    /**
     * A spent, unexpired link is the authorization here, so there is no current
     * password to verify. The library's own reset route always consumes its
     * verification token, which core does not use, so the credential account's
     * password is replaced with a hash the library itself produced.
     */
    async setPassword({ userId, newPassword }) {
      const hashed = await auth.$context.then((context) =>
        context.password.hash(newPassword),
      );
      const updated = await db("account")
        .where({ user_id: userId, provider_id: "credential" })
        .update({ password: hashed, updated_at: new Date() });
      if (updated === 0) throw new Error("no credential account to update");
    },

    async changeEmail({ userId, newEmail }) {
      await db("user")
        .where({ id: userId })
        .update({ email: newEmail, email_verified: true, updated_at: new Date() });
    },
  };
}
