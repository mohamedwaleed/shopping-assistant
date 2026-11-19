// SPDX-License-Identifier: AGPL-3.0-or-later
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
  /** ISO timestamp of the last admitted use of this session. */
  lastActiveAt: string;
}

/**
 * Turn a stored session row into the trusted identity core operations need.
 * Core accepts the stored session first, so the inactivity window and the
 * absolute maximum are applied to storage rather than to the cookie, and the
 * same rules govern every request. Membership is always read from the
 * database: a caller-supplied workspace identifier never reaches this
 * function, and the admission check compares it with stored membership so two
 * workspaces stay isolated.
 */
export async function resolveTrustedSession(
  authentication: Authentication,
  input: { userId: string; workspaceId: string; sessionId: string },
): Promise<TrustedSession | null> {
  const session = await authentication.requireSession(input.userId, input.sessionId);
  if (!session.ok) return null;

  const admission = await authentication.admission({
    kind: "workspace",
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
  });
  if (!admission.ok) return null;

  const admin = await authentication.administrator(input.userId);
  return {
    sessionId: input.sessionId,
    user: admission.value,
    principal: principalForUser(
      admission.value.id,
      admission.value.workspace,
      admin.ok,
      input.sessionId,
    ),
    lastActiveAt: session.value.lastActiveAt,
  };
}
