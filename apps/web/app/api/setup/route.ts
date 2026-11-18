// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const result = await getCore().auth.getSetupState();
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
