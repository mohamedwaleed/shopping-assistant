// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/**
 * Consent to spend this workspace's own provider key on background work.
 * Explicit and revocable: without it background monitoring pauses instead of
 * silently moving to the installation account.
 */
export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();

  const body = await jsonBody(request);
  if (typeof body.backgroundAllowed !== "boolean") {
    return errorResponse({
      kind: "invalid-input",
      field: "backgroundAllowed",
      message: "backgroundAllowed must be true or false",
    });
  }
  const result = await getCore().budgets.setPersonalKeyBackgroundConsent(
    principal,
    body.backgroundAllowed,
  );
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
