// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * The workspace's ChatGPT plan eligibility view. Core reads the workspace from
 * stored membership, so this never names another workspace's connection, and
 * the view is masked: no token, ciphertext or client id is ever returned.
 */
export async function GET(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const result = await getCore().chatgptPlan.read(principal);
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
