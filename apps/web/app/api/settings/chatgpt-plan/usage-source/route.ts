// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ChatGPTPlanUsageSource } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * Change which account pays for this workspace's inference. This is always an
 * explicit shopper choice: a paused or exhausted plan never switches billing on
 * its own, and switching to the plan requires a connected, plan-enabled grant.
 */
export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const body = await jsonBody(request);
  const result = await getCore().chatgptPlan.setUsageSource(principal, {
    usageSource: body.usageSource as ChatGPTPlanUsageSource,
  });
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
