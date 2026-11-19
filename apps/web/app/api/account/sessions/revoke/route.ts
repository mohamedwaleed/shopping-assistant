// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { expiredSessionCookies } from "@/lib/auth/cookies";

export const dynamic = "force-dynamic";

/**
 * Revoke one stored session by identifier, or every session of the account
 * when no identifier is given. The principal comes from the cookie session, so
 * only the caller's own sessions are reachable, and the revocation is a
 * delete: a client that keeps replaying the cookie is refused by core.
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const body = (await request.json().catch(() => ({}))) as { sessionId?: unknown };
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const auth = getCore().auth;

  if (!sessionId) {
    const result = await auth.revokeAllSessions(identity.trusted.principal);
    if (!result.ok) return errorResponse(result.error);
    const headers = new Headers({ "content-type": "application/json" });
    for (const cookie of expiredSessionCookies()) headers.append("set-cookie", cookie);
    return new Response(JSON.stringify({ revoked: result.value.revoked }), { status: 200, headers });
  }

  const result = await auth.revokeSession(identity.trusted.principal, { sessionId });
  if (!result.ok) return errorResponse(result.error);

  const headers = new Headers({ "content-type": "application/json" });
  if (sessionId === identity.sessionId) {
    for (const cookie of expiredSessionCookies()) headers.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify({ revoked: result.value.revoked }), { status: 200, headers });
}
