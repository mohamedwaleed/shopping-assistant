// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth, requestIdentity } from "@/lib/auth/session";
import { createCredentialChanger } from "@/lib/auth/credentials";
import { sameOriginRejected } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface PasswordBody {
  currentPassword?: unknown;
  newPassword?: unknown;
  secondFactorCode?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Change the account password. Core requires recent authentication and
 * validates the new password; the identity library verifies the current one
 * and replaces the hash. Every other device is signed out, so a password that
 * leaked keeps working nowhere.
 */
export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "workspace.read" });

  const body = (await request.json().catch(() => ({}))) as PasswordBody;
  const credentials = createCredentialChanger(getAuth(), getDb(), {
    cookie: request.headers.get("cookie"),
  });

  const result = await getCore().auth.changePassword(
    identity.trusted.principal,
    {
      currentPassword: text(body.currentPassword),
      newPassword: text(body.newPassword),
      secondFactorCode: text(body.secondFactorCode),
    },
    credentials,
  );
  if (!result.ok) return errorResponse(result.error);
  return Response.json(result.value);
}
