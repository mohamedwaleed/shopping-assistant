// SPDX-License-Identifier: AGPL-3.0-or-later
import { headers as nextHeaders } from "next/headers";
import { getCore, getDb } from "@/lib/core";
import { createAuth, type ShoppingAuth } from "./server";
import { resolveTrustedSession, type TrustedSession } from "./trusted-session";

let auth: ShoppingAuth | undefined;

export function getAuth(): ShoppingAuth {
  if (!auth) {
    auth = createAuth({
      db: getDb(),
      baseURL: process.env.BETTER_AUTH_URL,
      secret: process.env.BETTER_AUTH_SECRET,
    });
  }
  return auth;
}

export function closeAuth(): void {
  auth = undefined;
}

export interface RequestIdentity {
  /** Identity-library session id, for sign-out of this device. */
  sessionId: string;
  trusted: TrustedSession;
}

/**
 * Resolve the trusted identity for a request from its cookie session. The
 * identity library verifies the cookie; core then admits the user and reads
 * workspace membership from PostgreSQL. Nothing in the request body or query
 * string can select a workspace.
 */
export async function requestIdentity(
  request?: Request,
): Promise<RequestIdentity | null> {
  const requestHeaders = request
    ? new Headers(request.headers)
    : await nextHeaders();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session?.user) return null;

  const db = getDb();
  const membership = await db("workspace_memberships")
    .where({ user_id: session.user.id })
    .select("workspace_id")
    .first();
  if (!membership) return null;

  const trusted = await resolveTrustedSession(db, getCore().auth, {
    userId: session.user.id,
    workspaceId: membership.workspace_id,
    sessionExpiresAt: session.session.expiresAt,
    sessionId: session.session.id,
  });
  if (!trusted) return null;
  return { sessionId: session.session.id, trusted };
}
