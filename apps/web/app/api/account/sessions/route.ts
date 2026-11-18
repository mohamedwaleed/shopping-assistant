// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * The caller's signed-in devices, read from stored sessions. The principal is
 * built from the cookie session only, so the list can never include another
 * account's devices.
 */
export async function GET(request: Request): Promise<Response> {
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const result = await getCore().auth.listSessions(identity.trusted.principal);
  if (!result.ok) return errorResponse(result.error);

  return Response.json({
    sessions: result.value.sessions.map((session) => ({
      id: session.id,
      current: session.current,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })),
  });
}
