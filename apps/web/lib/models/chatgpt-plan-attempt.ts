// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

/**
 * The browser-bound half of a ChatGPT plan consent attempt. The PKCE verifier
 * and the OAuth state never leave the server, and the attempt is bound to the
 * browser that started it by an HttpOnly, SameSite cookie, so a callback from
 * another browser (or a replayed one) cannot complete someone else's consent.
 */
export const PLAN_CONSENT_COOKIE = "chatgpt-plan-consent";

export interface ConsentAttempt {
  state: string;
  /** SHA-256 of the verifier; the verifier itself is never written anywhere. */
  verifierHash: string;
}

/** True when the presented verifier is the one this attempt committed to. */
export function verifierMatches(attempt: ConsentAttempt, verifier: unknown): boolean {
  if (typeof verifier !== "string" || verifier.length === 0) return false;
  const presented = digest(verifier);
  if (presented.length !== attempt.verifierHash.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ attempt.verifierHash.charCodeAt(index);
  }
  return difference === 0;
}

/** Attempts are short-lived: the shopper authorizes in the same sitting. */
export const PLAN_CONSENT_SECONDS = 600;

function digest(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/**
 * The cookie value for one attempt. The route attaches it with `Set-Cookie`
 * itself, so the binding is part of the response it returns rather than a
 * mutation of an ambient cookie store.
 */
export function consentAttemptCookie(input: {
  state: string;
  codeVerifier: string;
}): string {
  const attempt: ConsentAttempt = { state: input.state, verifierHash: digest(input.codeVerifier) };
  const value = encodeURIComponent(JSON.stringify(attempt));
  const attributes = [
    `${PLAN_CONSENT_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${PLAN_CONSENT_SECONDS}`,
  ];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

/** The attempt this browser started, read from the request it presented. */
export function readConsentAttempt(request: Request): ConsentAttempt | null {
  const raw = cookieValue(request.headers.get("cookie"), PLAN_CONSENT_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentAttempt>;
    if (typeof parsed.state !== "string" || typeof parsed.verifierHash !== "string") return null;
    return { state: parsed.state, verifierHash: parsed.verifierHash };
  } catch {
    return null;
  }
}

/** Clear the binding once the attempt is spent, whatever the outcome. */
export function clearedConsentCookie(): string {
  const attributes = [`${PLAN_CONSENT_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Compare a callback's state with the browser-bound attempt in constant time. */
export function stateMatches(attempt: ConsentAttempt, state: unknown): boolean {
  if (typeof state !== "string" || state.length !== attempt.state.length) return false;
  let difference = 0;
  for (let index = 0; index < state.length; index += 1) {
    difference |= state.charCodeAt(index) ^ attempt.state.charCodeAt(index);
  }
  return difference === 0;
}
