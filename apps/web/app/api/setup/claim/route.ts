// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface ClaimBody {
  token?: unknown;
  name?: unknown;
  email?: unknown;
  password?: unknown;
  workspaceName?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Claim the installation once. The one-time token is held by the operator in
 * the environment, the claim is recorded with a conditional update before any
 * identity is created, and no SMTP delivery is involved (docs/adr/0009).
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as ClaimBody;

  const auth = getAuth();
  const provisioner = createAccountProvisioner(auth, getDb());
  // The setup request is not itself an identity-library request, so the
  // session cookie is issued by signing in once after provisioning.
  let sessionHeaders: Headers | undefined;

  const result = await getCore().auth.claimSetup(
    {
      token: text(body.token),
      name: text(body.name),
      email: text(body.email),
      password: text(body.password),
      workspaceName: text(body.workspaceName),
      sessionEstablished: true,
    },
    {
      createCredentialAccount: async (input) => {
        const created = await provisioner.createCredentialAccount(input);
        const signIn = await auth.api.signInEmail({
          body: { email: input.email, password: input.password },
          returnHeaders: true,
        });
        sessionHeaders = signIn.headers;
        return created;
      },
      deleteIdentity: provisioner.deleteIdentity,
      verifyCredentials: provisioner.verifyCredentials,
    },
  );

  if (!result.ok) return errorResponse(result.error);

  const responseHeaders = new Headers({ "content-type": "application/json" });
  for (const cookie of sessionHeaders?.getSetCookie() ?? []) {
    responseHeaders.append("set-cookie", cookie);
  }
  return new Response(
    JSON.stringify({ user: result.value.user, administrator: result.value.administrator }),
    { status: 200, headers: responseHeaders },
  );
}
