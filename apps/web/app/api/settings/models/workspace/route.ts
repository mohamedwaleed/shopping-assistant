// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";
import { saveRequestFrom } from "@/lib/models/settings-request";

export const dynamic = "force-dynamic";

/**
 * The workspace's own model override. Core reads the workspace from stored
 * membership, so a request naming another workspace cannot change or reveal it.
 */
export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const body = await jsonBody(request);
  const result = await getCore().models.saveWorkspace(principal, saveRequestFrom(body));
  if (!result.ok) return errorResponse(result.error);
  return Response.json({ workspace: result.value });
}
