// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { email?: unknown; token?: unknown };
  const result = await getCore().emailLinks.confirmEmailChange({
    email: typeof body.email === "string" ? body.email : "",
    token: typeof body.token === "string" ? body.token : "",
  });
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}
