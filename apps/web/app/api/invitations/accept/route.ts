// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore, getDb } from "@/lib/core";
import { getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

interface AcceptBody {
  token?: unknown;
  name?: unknown;
  password?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Accept an invitation. The token names the invited address, so the account is
 * created for that mailbox only, and acceptance is the single-use moment: a
 * replayed or expired link admits nobody.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as AcceptBody;
  const result = await getCore().accountLinks.acceptInvitation(
    {
      token: text(body.token),
      name: text(body.name),
      password: text(body.password),
    },
    createAccountProvisioner(getAuth(), getDb()),
  );
  if (!result.ok) return errorResponse(result.error);
  return Response.json({ user: result.value.user });
}
