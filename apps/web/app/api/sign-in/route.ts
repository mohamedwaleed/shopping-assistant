// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface SignInBody {
  email?: unknown;
  password?: unknown;
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

  const auth = getAuth();
  const provisioner = createAccountProvisioner(auth, getDb());
  // The identity library writes the session cookie through Next.js cookies(),
  // which needs an actual request scope; the session cookie is therefore
  // issued by the identity library for this request and returned as headers.
  let sessionHeaders: Headers | undefined;
  const result = await getCore().auth.signIn(
    { email, password, sessionEstablished: true },
    {
      ...provisioner,
      verifyCredentials: async (input) => {
        const verified = await provisioner.verifyCredentials(input);
        if (!verified) return null;
        const signIn = await auth.api.signInEmail({
          body: { email: input.email, password: input.password },
          returnHeaders: true,
        });
        sessionHeaders = signIn.headers;
        return verified;
      },
    },
  );
  if (!result.ok) return errorResponse(result.error);

  const responseHeaders = new Headers({ "content-type": "application/json" });
  for (const cookie of sessionHeaders?.getSetCookie() ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }
  return new Response(JSON.stringify({ user: result.value }), {
    status: 200,
    headers: responseHeaders,
  });
}
