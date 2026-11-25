import { hashPassword } from "better-auth/crypto";
import type { PasswordSetter } from "@shopping-assistant/engine";
import type { Auth } from "./auth.ts";

/**
 * Writes the credential a password reset asked for. The reset flow already
 * replaced the old password, so anything that could have been signed in with it
 * — including a session an attacker opened — ends with it: every session the
 * account holds is revoked in the same call.
 */
export function createPasswordSetter(auth: Auth): PasswordSetter {
  return {
    async setPassword(identityId, password) {
      const context = await auth.$context;
      const hashed = await hashPassword(password);
      const existing = await context.internalAdapter.findCredentialAccount(identityId);
      if (existing) {
        await context.internalAdapter.updatePassword(identityId, hashed);
      } else {
        await context.internalAdapter.createAccount({
          accountId: identityId,
          providerId: "credential",
          userId: identityId,
          password: hashed,
        });
      }
      await context.internalAdapter.deleteUserSessions(identityId);
    },
  };
}

/**
 * Verifies the address an invitation was sent to. The link reached that inbox,
 * which is the proof a verification email would otherwise ask for, and an
 * invited account must be able to sign in straight away.
 */
export async function markEmailVerified(auth: Auth, identityId: string): Promise<void> {
  const context = await auth.$context;
  await context.internalAdapter.updateUser(identityId, { emailVerified: true });
}
