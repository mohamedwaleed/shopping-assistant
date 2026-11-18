// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth.session_data",
  "__Secure-better-auth.session_data",
];

function expiredCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Sign out of this device: the stored session is revoked, so the same cookie
 * stops working even if a client keeps it, and the cookie is cleared.
 */
export async function POST(request: Request): Promise<Response> {
  const identity = await requestIdentity(request);

  if (identity) {
    await getDb()("session").where({ id: identity.sessionId }).delete();
    const result = await getCore().auth.signOut({ sessionRevoked: true });
    if (!result.ok) return errorResponse(result.error);
  }

  const headers = new Headers({ "content-type": "application/json" });
  for (const name of SESSION_COOKIE_NAMES) headers.append("set-cookie", expiredCookie(name));
  return new Response(JSON.stringify({ signedOut: true }), { status: 200, headers });
}
