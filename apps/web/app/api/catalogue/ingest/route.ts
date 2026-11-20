// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

/** An admitted shopper submits a URL; the core owns URL, policy and fetch safety. */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const body = await jsonBody(request);
  const url = typeof body.url === "string" ? body.url : "";
  const result = await getCore().catalogue.ingestProductPage(principal, url);
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value, { status: 201 });
}
