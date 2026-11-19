// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { sameOriginRejected } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Verifies enrollment and returns recovery codes once, over the protected account session. */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });
  const body = await request.json().catch(() => ({})) as { code?: unknown };
  const result = await getCore().auth.confirmTwoFactorEnrollment(identity.trusted.principal, { code: typeof body.code === "string" ? body.code : "" });
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}
