// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { nodemailerTransport } from "@shopping/core/mail-transport";
import { requestIdentity } from "@/lib/auth/session";
import { sameOriginRejected } from "@/lib/csrf";
import { linkBaseUrl } from "@/lib/email-link-request";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Start an email-address change. Core requires recent authentication and the
 * enrolled authenticator before anything is sent, and the sign-in address only
 * moves once the link delivered to the new mailbox is opened
 * (`POST /api/account/email/confirm`, and `/account/email/confirm` for the
 * screen).
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const body = (await request.json().catch(() => ({}))) as { newEmail?: unknown; secondFactorCode?: unknown };
  const result = await getCore().emailLinks.requestEmailChange(identity.trusted.principal, {
    newEmail: typeof body.newEmail === "string" ? body.newEmail : "",
    secondFactorCode: typeof body.secondFactorCode === "string" ? body.secondFactorCode : "",
    linkBaseUrl: linkBaseUrl("email-change", new URL(request.url).origin),
  }, nodemailerTransport());
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
