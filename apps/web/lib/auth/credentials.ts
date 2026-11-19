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
 * Email changes never reach this adapter: they need the SMTP-backed account
 * flows (ticket 04), and core refuses them before any credential work.
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

    async changeEmail() {
      throw new Error("email changes travel through the SMTP-backed account flows");
    },
  };
}
