// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createCredentialChanger } from "@/lib/auth/credentials";
import { expiredSessionCookies } from "@/lib/auth/cookies";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface ConfirmBody {
  token?: unknown;
  newPassword?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Spend a reset link. The link is single-use, so exactly one consumer can
 * change the password, and every session of that account is revoked first: a
 * browser that was already signed in has to sign in again with the new
 * password. Any cookie this browser still holds is cleared too.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ConfirmBody;
  const result = await getCore().accountLinks.resetPassword(
    { token: text(body.token), newPassword: text(body.newPassword) },
    createCredentialChanger(getAuth(), getDb(), { cookie: request.headers.get("cookie") }),
  );
  if (!result.ok) return errorResponse(result.error);

  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of expiredSessionCookies()) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(result.value), { status: 200, headers });
}
