// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_REDIRECT_URI } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";
import { sameOriginRejected } from "@/lib/csrf";
import { jsonBody, settingsPrincipal, unauthenticated } from "@/lib/models/request";
import {
  clearedConsentCookie,
  readConsentAttempt,
  stateMatches,
  verifierMatches,
} from "@/lib/models/chatgpt-plan-attempt";
import { exchangeAuthorizationCode } from "@/lib/models/chatgpt-plan-oauth";

export const dynamic = "force-dynamic";

/** The redirect URI this installation asked the provider for. */
export function planRedirectUri(): string {
  return process.env.CHATGPT_PLAN_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
}

/**
 * The provider returns the browser here after the shopper authorizes the
 * workspace's ChatGPT plan connection. The attempt must belong to this browser,
 * and a declined consent ends the attempt without storing anything. The code is
 * exchanged once; the tokens go straight into core, which encrypts them for the
 * workspace and returns only the masked view.
 */
export async function POST(request: Request): Promise<Response> {
  const principal = await settingsPrincipal(request);
  if (!principal) return unauthenticated();
  if (sameOriginRejected(request)) return errorResponse({ kind: "invalid-origin" });

  const attempt = readConsentAttempt(request);
  if (!attempt) {
    return errorResponse({
      kind: "invalid-input",
      field: "state",
      message: "no consent attempt is bound to this browser; start the connection again",
    });
  }
  const body = await jsonBody(request);
  if (!stateMatches(attempt, body.state)) {
    return errorResponse({
      kind: "invalid-input",
      field: "state",
      message: "the returned state does not match this browser's consent attempt",
    });
  }

  const providerError = typeof body.error === "string" ? body.error : undefined;
  if (providerError) {
    const declined = await getCore().chatgptPlan.completeConsent(principal, null, {
      error: providerError,
    });
    if (!declined.ok) return errorResponse(declined.error);
    return Response.json(declined.value, { headers: { "set-cookie": clearedConsentCookie() } });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return errorResponse({
      kind: "invalid-input",
      field: "code",
      message: "the provider returned no authorization code",
    });
  }
  // The cookie holds only the verifier's digest. The verifier itself travels
  // back from the consent screen in the callback, and it is accepted only when
  // it hashes to the digest this browser's attempt committed to: a callback
  // from another browser cannot produce a matching pair, and nothing secret is
  // persisted server-side between the two requests.
  const codeVerifier = verifierMatches(attempt, body.codeVerifier)
    ? (body.codeVerifier as string)
    : "";
  if (!codeVerifier) {
    return errorResponse({
      kind: "invalid-input",
      field: "codeVerifier",
      message: "the authorization code was not issued for this browser's consent attempt",
    });
  }
  const exchanged = await exchangeAuthorizationCode({
    code,
    codeVerifier,
    redirectUri: planRedirectUri(),
    clientId: typeof body.clientId === "string" ? body.clientId : null,
  });
  if (!exchanged.ok) {
    return errorResponse({
      kind: "invalid-input",
      field: "code",
      message: `the authorization code could not be exchanged (${exchanged.error})`,
    });
  }

  const stored = await getCore().chatgptPlan.completeConsent(principal, exchanged.grant);
  if (!stored.ok) return errorResponse(stored.error);
  return Response.json(stored.value, { headers: { "set-cookie": clearedConsentCookie() } });
}
