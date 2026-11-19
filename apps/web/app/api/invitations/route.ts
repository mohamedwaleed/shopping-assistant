// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { sameOriginRejected } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface InvitationBody {
  email?: unknown;
  name?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Invite a shopper. Only the installation administrator may invite, the link is
 * delivered over the configured SMTP settings, and acceptance creates a private
 * workspace for that shopper alone (docs/adr/0009).
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "installation.manage" });

  const body = (await request.json().catch(() => ({}))) as InvitationBody;
  const result = await getCore().accountLinks.invite(identity.trusted.principal, {
    email: text(body.email),
    name: text(body.name),
  });
  if (!result.ok) return errorResponse(result.error);
  return Response.json({
    delivered: true,
    recipient: result.value.recipient,
    deliveredAt: result.value.deliveredAt,
  });
}
