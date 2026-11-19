// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

/**
 * What the recovery command needs from the installation, kept apart from the
 * command itself so the decision can be exercised without a shell: which
 * address to recover, which new password to set, and the stored facts the
 * command is allowed to act on.
 */
export interface RecoveryTarget {
  /** Address the operator names; there is no "first user" guess. */
  email: string;
  newPassword: string;
}

export interface RecoveryState {
  /** Token held by the deployment's environment. */
  configuredToken: string | null;
  presentedToken: string;
  /** The address the operator named, or null when no account has it. */
  user: { id: string; email: string } | null;
  /** The installation administrator recorded by the setup claim, or null. */
  administratorUserId: string | null;
  sessionCount: number;
}

export type RecoveryDecision =
  | { kind: "refused"; reason: "recovery-token-missing" | "invalid-recovery-token" }
  | { kind: "refused"; reason: "unknown-address" }
  | { kind: "refused"; reason: "not-the-administrator" }
  | { kind: "recovered"; userId: string; sessionsRevoked: number };

export function hashRecoveryToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Decide an administrator recovery. This is operator-only by construction: it
 * needs the deployment's recovery token, which is held outside the database,
 * and it only ever acts on the account the setup claim recorded as the
 * installation administrator. Every refusal is deliberate and says why.
 */
export function decideRecovery(
  target: RecoveryTarget,
  state: RecoveryState,
): RecoveryDecision {
  if (!state.configuredToken) return { kind: "refused", reason: "recovery-token-missing" };
  if (state.presentedToken !== state.configuredToken) {
    return { kind: "refused", reason: "invalid-recovery-token" };
  }
  if (!state.user) return { kind: "refused", reason: "unknown-address" };
  if (state.user.id !== state.administratorUserId) {
    return { kind: "refused", reason: "not-the-administrator" };
  }
  return { kind: "recovered", userId: state.user.id, sessionsRevoked: state.sessionCount };
}
