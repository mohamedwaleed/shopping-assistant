// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createCredentialChanger } from "@/lib/auth/credentials";
import { expiredSessionCookies } from "@/lib/auth/cookies";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Confirm the new address from the link sent to it. The link is single-use and
 * expires in thirty minutes; once spent the account signs in as the new
 * address and every session issued under the old one is revoked, so this
 * browser has to sign in again.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { token?: unknown };
  const result = await getCore().accountLinks.confirmEmailChange(
    { token: typeof body.token === "string" ? body.token : "" },
    createCredentialChanger(getAuth(), getDb(), { cookie: request.headers.get("cookie") }),
  );
  if (!result.ok) return errorResponse(result.error);

  const headers = new Headers({ "content-type": "application/json" });
  for (const cookie of expiredSessionCookies()) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(result.value), { status: 200, headers });
}
