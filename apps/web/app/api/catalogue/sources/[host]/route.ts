// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * Source coverage for one host. The catalogue is public data, so any admitted
 * member may read what a source is worth; core owns the authorization and the
 * host validation.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ host: string }> },
): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const { host } = await context.params;
  const result = await getCore().sources.coverage(principal, host);
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}
