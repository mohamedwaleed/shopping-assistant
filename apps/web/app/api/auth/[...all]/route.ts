// SPDX-License-Identifier: AGPL-3.0-or-later
import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/session";

const handler = toNextJsHandler(getAuth().handler);

// Invitation-only admission: the identity library's own sign-up route is not
// reachable from the internet. Accounts are created by the one-time setup
// claim or, from ticket 04 onwards, an accepted invitation.
async function withoutPublicSignUp(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.endsWith("/sign-up/email")) {
    return Response.json(
      { error: { kind: "registration-closed" } },
      { status: 403 },
    );
  }
  return handler.POST(request);
}

export const GET = handler.GET;
export const POST = withoutPublicSignUp;
