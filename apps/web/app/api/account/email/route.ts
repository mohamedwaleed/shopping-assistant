// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { sameOriginRejected } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Ask to change the sign-in address. Core requires recent authentication and
 * sends the confirmation to the new mailbox; the address only becomes the
 * identity once that link is confirmed, so this reports nothing more than
 * that a confirmation was sent. Unavailable email is reported as such, never
 * as a completed change.
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const body = (await request.json().catch(() => ({}))) as { newEmail?: unknown };
  const result = await getCore().auth.changeEmail(
    identity.trusted.principal,
    { newEmail: typeof body.newEmail === "string" ? body.newEmail : "" },
    getCore().accountLinks,
  );
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value, { status: 202 });
}
