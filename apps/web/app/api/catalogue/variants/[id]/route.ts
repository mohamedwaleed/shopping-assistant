// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Principal } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";

// Public catalogue facts are readable without a workspace principal; private
// operations arrive with the workspace-access story.
const CATALOGUE_PRINCIPAL: Principal = { kind: "anonymous" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const result = await getCore().catalogue.getVariantOfferDetail(
    CATALOGUE_PRINCIPAL,
    id,
  );

  if (!result.ok) {
    return errorResponse(result.error);
  }
  return Response.json(result.value);
}
