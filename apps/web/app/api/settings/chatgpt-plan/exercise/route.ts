// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

const DEFAULT_PROMPT =
  "Call the requirements_update tool for this shopping request: a quiet laptop under €1000.";

/**
 * Prove the connection serves shopping work, not just text: one bounded turn
 * through the account's own model must call and execute the typed shopping
 * tool. A text-only answer leaves `toolsExecuted` empty, and a refused or
 * paused plan is reported as a typed conflict rather than retried or paid for
 * with an API key.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const body = await jsonBody(request);
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : DEFAULT_PROMPT;
  const tools = Array.isArray(body.tools)
    ? body.tools.filter((name): name is string => typeof name === "string")
    : undefined;

  const result = await getCore().chatgptPlan.exercisePlan(principal, {
    prompt,
    ...(tools && tools.length > 0 ? { tools } : {}),
  });
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
