// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import {
  principalForUser,
  type AuthenticatedUser,
  type Authentication,
  type Principal,
} from "@shopping/core";

export interface TrustedSession {
  /** Session identifier the identity library verified. */
  sessionId: string;
  user: AuthenticatedUser;
  /** Workspace membership plus installation role, resolved from storage. */
  principal: Principal;
  /** False when the stored session has passed its expiry. */
  active: boolean;
}

/**
 * Turn a stored session row into the trusted identity core operations need.
 * Membership is always read from the database: a caller-supplied workspace
 * identifier never reaches this function, and the admission check compares it
 * with stored membership so two workspaces stay isolated.
 */
export async function resolveTrustedSession(
  db: Knex,
  authentication: Authentication,
  input: {
    userId: string;
    workspaceId: string;
    sessionExpiresAt: Date | string;
    sessionId: string;
  },
): Promise<TrustedSession | null> {
  const admission = await authentication.admission({
    kind: "workspace",
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  if (!admission.ok) return null;
  const admin = await authentication.administrator(input.userId);
  const expiresAt = new Date(input.sessionExpiresAt);
  return {
    sessionId: input.sessionId,
    user: admission.value,
    principal: principalForUser(admission.value.id, admission.value.workspace, admin.ok),
    active: expiresAt.getTime() > Date.now(),
  };
}
