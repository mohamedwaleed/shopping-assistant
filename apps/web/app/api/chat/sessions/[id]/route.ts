// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { settingsPrincipal, unauthenticated } from "@/lib/models/request";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const { id } = await context.params;
  const result = await getCore().chat.get(principal, id);
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}
