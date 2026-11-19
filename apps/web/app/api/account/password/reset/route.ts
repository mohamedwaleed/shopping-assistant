// SPDX-License-Identifier: AGPL-3.0-or-later
import { nodemailerTransport } from "@shopping/core/mail-transport";
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createPasswordRecovery } from "@/lib/auth/credentials";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
const text = (value: unknown) => typeof value === "string" ? value : "";

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => ({})) as { email?: unknown; token?: unknown; newPassword?: unknown };
  const origin = new URL(request.url).origin;
  if (!body.token) {
    const result = await getCore().emailLinks.requestPasswordReset({ email: text(body.email), linkBaseUrl: `${origin}/reset-password` }, nodemailerTransport());
    return result.ok ? Response.json(result.value) : errorResponse(result.error);
  }
  const result = await getCore().emailLinks.resetPassword({ email: text(body.email), token: text(body.token), newPassword: text(body.newPassword) }, createPasswordRecovery(getAuth(), getDb()));
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}
