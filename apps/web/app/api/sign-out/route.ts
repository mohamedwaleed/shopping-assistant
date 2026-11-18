// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { expiredSessionCookies } from "@/lib/auth/cookies";
import { sameOriginRejected } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Sign out of this device: the stored session is revoked, so the same cookie
 * stops working even if a client keeps it, and the cookie is cleared.
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);

  if (identity) {
    const result = await getCore().auth.revokeSession(identity.trusted.principal, {
      sessionId: identity.sessionId,
    });
    if (!result.ok && result.error.kind !== "not-found") return errorResponse(result.error);
  }

  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of expiredSessionCookies()) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify({ signedOut: true }), { status: 200, headers });
}
