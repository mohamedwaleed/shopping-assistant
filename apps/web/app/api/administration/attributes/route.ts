// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

/** Installation administrators resolve only pending catalogue vocabulary. */
export async function GET(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const result = await getCore().catalogue.listAttributeReviews(principal);
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}

export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const body = await jsonBody(request);
  const claimId = typeof body.claimId === "string" ? body.claimId : "";
  const canonicalKey = typeof body.canonicalKey === "string" ? body.canonicalKey : body.canonicalKey === null ? null : "";
  const result = await getCore().catalogue.reviewAttributeClaim(principal, claimId, canonicalKey);
  return result.ok ? Response.json({ reviewed: true }) : errorResponse(result.error);
}
