// SPDX-License-Identifier: AGPL-3.0-or-later
import { nodemailerTransport } from "@shopping/core/mail-transport";
import { getCore, getDb } from "@/lib/core";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { getAuth, requestIdentity } from "@/lib/auth/session";
import { sameOriginRejected } from "@/lib/csrf";
import { linkBaseUrl } from "@/lib/email-link-request";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";
const text = (value: unknown) => typeof value === "string" ? value : "";

export async function POST(request: Request): Promise<Response> {
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  if ("token" in body) {
    const result = await getCore().emailLinks.acceptInvitation({ email: text(body.email), token: text(body.token), name: text(body.name), password: text(body.password), workspaceName: text(body.workspaceName) }, createAccountProvisioner(getAuth(), getDb()));
    return result.ok ? Response.json(result.value) : errorResponse(result.error);
  }
  const identity = await requestIdentity(request);
  if (!identity) return errorResponse({ kind: "forbidden", capability: "installation.manage" });
  const result = await getCore().emailLinks.invite(identity.trusted.principal, { email: text(body.email), linkBaseUrl: linkBaseUrl("invitation", new URL(request.url).origin) }, nodemailerTransport());
  return result.ok ? Response.json(result.value) : errorResponse(result.error);
}
