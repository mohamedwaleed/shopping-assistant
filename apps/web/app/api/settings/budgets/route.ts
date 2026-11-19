// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { allowanceRequestFrom } from "@/lib/models/budget-request";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * Budget allowances and usage. Reading is available to any admitted member so
 * settings can explain why work paused; writing an installation ceiling or a
 * workspace permission is limited to the installation administrator by core.
 */
export async function GET(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const result = await getCore().budgets.read(principal);
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}

export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const body = await jsonBody(request);
  const result = await getCore().budgets.saveAllowance(principal, allowanceRequestFrom(body));
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
