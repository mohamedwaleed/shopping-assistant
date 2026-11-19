// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Protected installation email settings. Only the administrator reaches these
 * routes (core enforces installation.manage) and the stored SMTP password is
 * never serialized: the response carries `passwordSet` instead.
 */
export async function GET(request: Request): Promise<Response> {
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "installation.manage" });

  const result = await getCore().mail.settings(identity.trusted.principal);
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}

export async function PUT(request: Request): Promise<Response> {
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "installation.manage" });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return errorResponse({ kind: "invalid-input", field: "body", message: "JSON body is required" });
  }

  const result = await getCore().mail.saveSettings(identity.trusted.principal, {
    host: String(body.host ?? ""),
    port: Number(body.port),
    secure: body.secure === true,
    username: String(body.username ?? ""),
    password: typeof body.password === "string" ? body.password : undefined,
    fromAddress: String(body.fromAddress ?? ""),
    fromName: String(body.fromName ?? ""),
    recipient: typeof body.recipient === "string" ? body.recipient : undefined,
  });
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
