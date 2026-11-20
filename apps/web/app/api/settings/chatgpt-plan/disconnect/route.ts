// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * Disconnect the workspace's plan connection. Core replaces the stored grant
 * with unusable ciphertext and returns the connection to API-key usage, so a
 * later request cannot keep spending a plan the shopper removed.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const result = await getCore().chatgptPlan.disconnect(principal);
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
