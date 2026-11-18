// SPDX-License-Identifier: AGPL-3.0-or-later
import { nodemailerTransport } from "@shopping/core";
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Deliberate diagnostic delivery to the explicitly configured recipient. The
 * outcome follows the shared mailer contract, so a connection problem, an
 * authentication problem and a delivery problem stay distinguishable.
 */
export async function POST(request: Request): Promise<Response> {
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const result = await getCore().mail.sendDiagnostic(
    identity.trusted.principal,
    nodemailerTransport(),
  );
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
