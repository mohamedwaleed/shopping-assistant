// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

/** Session navigation and creation stay a thin authenticated transport over core. */
export async function GET(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const result = await getCore().chat.list(principal);
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}

export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const body = await jsonBody(request);
  const result = await getCore().chat.create(principal, {
    title: typeof body.title === "string" ? body.title : "",
    language: body.language === "nl" ? "nl" : "en",
  });
  return result.ok ? Response.json(result.value, { status: 201 }) : errorResponse(result.error);
}
