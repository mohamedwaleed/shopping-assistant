// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";
import { cookies } from "next/headers";

/** Session cookies the identity library writes; both the secure and plain name. */
export const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth.session_data",
  "__Secure-better-auth.session_data",
];

/** Cookie attributes the identity library sets on a session cookie. */
export function sessionCookieOptions(): Partial<ResponseCookie> {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  };
}

/**
 * Copy session cookies issued by the identity library into the Next.js cookie
 * store. The library writes cookies itself only inside its own request scope,
 * and the setup/sign-in screens call it from a server action. HttpOnly and
 * SameSite are always enforced, whatever the library sent.
 */
export async function applySetCookies(headers: Headers): Promise<void> {
  const store = await cookies();
  for (const cookie of headers.getSetCookie()) {
    const [pair = "", ...attributes] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = decodeURIComponent(pair.slice(separator + 1).trim());
    const options: Partial<ResponseCookie> = sessionCookieOptions();
    for (const attribute of attributes) {
      const [rawKey = "", rawValue = ""] = attribute.split("=");
      const key = rawKey.trim().toLowerCase();
      const attributeValue = rawValue.trim();
      if (key === "max-age") options.maxAge = Number(attributeValue);
      if (key === "expires") options.expires = new Date(attributeValue);
      if (key === "secure") options.secure = true;
    }
    store.set(name, value, options);
  }
}

/** Clear every session cookie name, for sign-out and revoke-everything. */
export function expiredSessionCookies(): string[] {
  return SESSION_COOKIE_NAMES.map(
    (name) =>
      `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` +
      (process.env.NODE_ENV === "production" ? "; Secure" : ""),
  );
}
