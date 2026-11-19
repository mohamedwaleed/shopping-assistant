// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

/** A no-provider execution check: reserve and cancel, exposing any pause reason. */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const body = await jsonBody(request);
  const reservation = await getCore().budgets.reserve(principal, {
    kind: body.kind === "background" ? "background" : "interactive",
    estimatedCents: body.estimatedCents as number,
    usageSource: body.usageSource === "workspace" ? "workspace" : "installation",
  });
  if (!reservation.ok) return errorResponse(reservation.error);
  const cancelled = await getCore().budgets.cancel(principal, reservation.value.id);
  if (!cancelled.ok) return errorResponse(cancelled.error);
  const budget = await getCore().budgets.read(principal);
  return budget.ok ? Response.json({ reservation: reservation.value, budget: budget.value }) : errorResponse(budget.error);
}
