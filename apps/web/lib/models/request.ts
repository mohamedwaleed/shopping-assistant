// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Principal } from "@shopping/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

/**
 * The principal a settings route acts for: the stored session only. A request
 * body or query string never selects a workspace or an installation role.
 */
export async function settingsPrincipal(request: Request): Promise<Principal | null> {
  const identity = await requestIdentity(request);
  return identity ? identity.trusted.principal : null;
}

export function unauthenticated(): Response {
  return errorResponse({ kind: "forbidden", capability: "workspace.read" });
}

/** Parse a JSON body without trusting its shape; core validates the fields. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
