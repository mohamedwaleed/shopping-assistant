// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";

export const dynamic = "force-dynamic";

interface ResetRequestBody {
  email?: unknown;
}

/**
 * Request a password reset. The answer is always the same accepted response,
 * for a known address, an unknown address and a delivery that failed, so this
 * endpoint cannot be used to discover which accounts exist.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ResetRequestBody;
  const email = typeof body.email === "string" ? body.email : "";
  const result = await getCore().accountLinks.requestPasswordReset({ email });
  // The only failure this can report is a malformed request, never account state.
  if (!result.ok) return Response.json({ accepted: true }, { status: 202 });
  return Response.json(result.value, { status: 202 });
}
