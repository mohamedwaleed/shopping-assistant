// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";
import { consentAttemptCookie } from "@/lib/models/chatgpt-plan-attempt";

export const dynamic = "force-dynamic";

/**
 * Start a provider consent attempt. This is provider OAuth for a workspace, not
 * application sign-in: it creates no user and links no account. The state and
 * PKCE verifier are bound to this browser in an HttpOnly, SameSite cookie that
 * this response sets, and only the authorization URL, the S256 challenge and
 * the public attempt values are returned.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const body = await jsonBody(request);
  const loginHint =
    typeof body.loginHint === "string" && body.loginHint.trim() ? body.loginHint.trim() : null;
  const attempt = await getCore().chatgptPlan.beginConsent(principal, { loginHint });
  if (!attempt.ok) return errorResponse(attempt.error);

  // The verifier goes back to the page that started the attempt and nowhere
  // else: the cookie keeps only its digest, so a callback from another browser
  // cannot complete this consent. Only the digest is persisted.
  const view = attempt.value;
  return Response.json(view, {
    headers: {
      "set-cookie": consentAttemptCookie({
        state: attempt.value.state,
        codeVerifier: attempt.value.codeVerifier,
      }),
    },
  });
}
