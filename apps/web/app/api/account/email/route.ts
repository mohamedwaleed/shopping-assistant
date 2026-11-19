// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { sameOriginRejected } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Email-address changes are deliberately not handled here. Proving ownership of
 * the new mailbox needs delivery, which arrives with the SMTP-backed account
 * flows (ticket 04), so the endpoint answers with a stable refusal instead of
 * changing the sign-in address without proof.
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const body = (await request.json().catch(() => ({}))) as { newEmail?: unknown };
  const result = await getCore().auth.changeEmail(identity.trusted.principal, {
    newEmail: typeof body.newEmail === "string" ? body.newEmail : "",
  });
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
