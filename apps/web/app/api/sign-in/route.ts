// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface SignInBody {
  email?: unknown;
  password?: unknown;
  secondFactorCode?: unknown;
}

/**
 * Email/password sign-in. The identity library verifies the credential; core
 * admits the user against stored workspace membership, and the session cookie
 * is written by the response itself.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as SignInBody;
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const secondFactorCode = typeof body.secondFactorCode === "string" ? body.secondFactorCode : "";

  const auth = getAuth();
  const provisioner = createAccountProvisioner(auth, getDb());
  const result = await getCore().auth.signIn(
    { email, password, secondFactorCode, sessionEstablished: true }, provisioner,
  );
  if (!result.ok) return errorResponse(result.error);
  // Do not issue a cookie until the core has accepted the authenticator code.
  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });

  const responseHeaders = new Headers({ "content-type": "application/json" });
  for (const cookie of signIn.headers.getSetCookie() ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify({ user: result.value }), {
    status: 200,
    headers: responseHeaders,
  });
}
