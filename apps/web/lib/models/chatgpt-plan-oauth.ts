// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CHATGPT_PLAN_RESOURCE,
  DEFAULT_TOKEN_URL,
  type ChatGPTPlanTokenGrant,
} from "@shopping/core";

/**
 * The provider's token endpoint (developers.openai.com/siwc/token-sharing-open-
 * source/sign-in). This is the only outbound OAuth call the installation makes;
 * it happens after the browser returns and never in a loop, so a refused grant
 * is reported to the shopper instead of being retried behind their back.
 */
/** The provider token endpoint; installation configuration so tests and a
 * self-hosted egress proxy can point it somewhere else. */
export function planTokenUrl(): string {
  return process.env.CHATGPT_PLAN_TOKEN_URL ?? DEFAULT_TOKEN_URL;
}

export interface TokenExchangeRequest {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId?: string | null;
}

export type TokenExchangeResult =
  | { ok: true; grant: ChatGPTPlanTokenGrant }
  | { ok: false; error: string };

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  client_id?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** The validated account identity comes from the ID token's subject. */
export function subjectFromIdToken(idToken: string): { subject: string; email: string | null } | null {
  const [, payload] = idToken.split(".");
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sub?: unknown;
      email?: unknown;
    };
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return { subject: claims.sub, email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    return null;
  }
}

export async function exchangeAuthorizationCode(
  request: TokenExchangeRequest,
  options: { tokenUrl?: string } = {},
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: request.clientId?.trim() || "dynamic_agent_client",
    code: request.code,
    code_verifier: request.codeVerifier,
    redirect_uri: request.redirectUri,
    resource: CHATGPT_PLAN_RESOURCE,
  });
  let response: Response;
  try {
    response = await fetch(options.tokenUrl ?? planTokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      // The code is single-use; a retry would only replay a spent grant.
      redirect: "error",
    });
  } catch {
    return { ok: false, error: "token-endpoint-unreachable" };
  }
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : `http-${response.status}`;
    return { ok: false, error: code };
  }
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
    // A grant without a refresh token cannot be resumed, so it is refused here
    // rather than stored and discovered later.
    return { ok: false, error: "incomplete-grant" };
  }
  const account =
    typeof payload.id_token === "string" ? subjectFromIdToken(payload.id_token) : null;
  if (!account) return { ok: false, error: "unverifiable-id-token" };
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return {
    ok: true,
    grant: {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
      account,
      clientId: typeof payload.client_id === "string" ? payload.client_id : "dynamic_agent_client",
    },
  };
}

export type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; error: string; transient: boolean };

/**
 * Spend the rotating refresh token. The provider's documented terminal errors
 * end the grant; anything else (a network failure, a provider outage) is
 * transient and must not erase a credential the shopper still holds.
 */
export async function refreshAuthorization(
  request: { refreshToken: string; clientId: string },
  options: { tokenUrl?: string } = {},
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: request.clientId,
    refresh_token: request.refreshToken,
    resource: CHATGPT_PLAN_RESOURCE,
  });
  let response: Response;
  try {
    response = await fetch(options.tokenUrl ?? planTokenUrl(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "error",
    });
  } catch {
    return { ok: false, error: "token-endpoint-unreachable", transient: true };
  }
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (response.status >= 500) {
    return { ok: false, error: `http-${response.status}`, transient: true };
  }
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : `http-${response.status}`;
    return { ok: false, error: code, transient: false };
  }
  if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
    return { ok: false, error: "incomplete-grant", transient: false };
  }
  return { ok: true, accessToken: payload.access_token, refreshToken: payload.refresh_token };
}
