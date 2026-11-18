// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * Run the bounded capability diagnostic for the model this workspace resolves
 * to. Core enforces the call and token bounds and refuses anything outside
 * them; the adapter makes the real SDK requests and reports which capabilities
 * the endpoint actually supports. Nothing here falls back to another provider.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const body = await jsonBody(request);
  const result = await getCore().models.testConnection(principal, {
    bounds: {
      ...(typeof body.maxCalls === "number" ? { maxCalls: body.maxCalls } : {}),
      ...(typeof body.maxOutputTokens === "number"
        ? { maxOutputTokens: body.maxOutputTokens }
        : {}),
    },
  });
  if (!result.ok) return errorResponse(result.error);
  return Response.json({ capability: result.value });
}
