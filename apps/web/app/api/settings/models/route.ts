// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";
import { saveRequestFrom } from "@/lib/models/settings-request";

export const dynamic = "force-dynamic";

/**
 * Installation model defaults. Reading is available to any admitted member so
 * settings can explain which model serves their workspace; writing is limited
 * to the installation administrator by core. Responses are masked views: the
 * API never returns a provider key.
 */
export async function GET(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const result = await getCore().models.read(principal);
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}

export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const body = await jsonBody(request);
  const result = await getCore().models.saveInstallation(principal, saveRequestFrom(body));
  if (!result.ok) return errorResponse(result.error);
  return Response.json({ installation: result.value });
}
