// SPDX-License-Identifier: AGPL-3.0-or-later
import { CHATGPT_PLAN_ACCESS_TOKEN_SECONDS } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { settingsPrincipal, unauthenticated } from "@/lib/models/request";
import { refreshAuthorization } from "@/lib/models/chatgpt-plan-oauth";

export const dynamic = "force-dynamic";

/**
 * Refresh the workspace's plan grant. The rotating refresh token is spent here
 * and replaced in one write by core; a terminal refresh error disconnects the
 * connection and asks the shopper to authorize again, while a transient network
 * failure changes nothing. No token is returned to the browser.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const core = getCore();
  const connection = await core.chatgptPlan.resolveRefresh(principal);
  if (!connection.ok) return errorResponse(connection.error);

  const refreshed = await refreshAuthorization({
    refreshToken: connection.value.refreshToken,
    clientId: connection.value.clientId,
  });
  if (!refreshed.ok) {
    if (refreshed.transient) {
      return errorResponse({
        kind: "chatgpt-plan-request-failed",
        code: refreshed.error,
        status: 502,
      });
    }
    const ended = await core.chatgptPlan.recordRefresh(principal, {
      kind: "invalid_grant",
      message: refreshed.error,
    });
    if (!ended.ok) return errorResponse(ended.error);
    return Response.json(ended.value);
  }

  const recorded = await core.chatgptPlan.recordRefresh(principal, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: new Date(Date.now() + CHATGPT_PLAN_ACCESS_TOKEN_SECONDS * 1000),
  });
  if (!recorded.ok) return errorResponse(recorded.error);
  return Response.json(recorded.value);
}
