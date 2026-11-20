// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const result = await getCore().budgets.read(principal);
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}

export async function PUT(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  const body = await jsonBody(request);
  const number = (name: string) => body[name] as number;
  const result = principal.kind === "administrator" && body.scope === "installation"
    ? await getCore().budgets.saveInstallation(principal, { interactiveCents: number("interactiveCents"), backgroundCents: number("backgroundCents"), maxInteractive: number("maxInteractive"), maxBackground: number("maxBackground"), retryLimit: number("retryLimit"), paidFallbackEnabled: body.paidFallbackEnabled === true })
    : await getCore().budgets.saveWorkspace(principal, { interactiveCents: number("interactiveCents"), backgroundCents: number("backgroundCents"), paidFallbackEnabled: body.paidFallbackEnabled === true, backgroundPersonalKeyConsent: body.backgroundPersonalKeyConsent === true });
  return result.ok ? Response.json({ budget: result.value }) : errorResponse(result.error);
}
