// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";
import { cookies } from "next/headers";

/**
 * Copy session cookies issued by the identity library into the Next.js cookie
 * store. The library writes cookies itself only inside its own request scope,
 * and the setup/sign-in screens call it from a server action.
 */
export async function applySetCookies(headers: Headers): Promise<void> {
  const store = await cookies();
  for (const cookie of headers.getSetCookie()) {
    const [pair = "", ...attributes] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = decodeURIComponent(pair.slice(separator + 1).trim());
    const options: Partial<ResponseCookie> = {};
    for (const attribute of attributes) {
      const [rawKey = "", rawValue = ""] = attribute.split("=");
      const key = rawKey.trim().toLowerCase();
      const attributeValue = rawValue.trim();
      if (key === "path") options.path = attributeValue;
      if (key === "httponly") options.httpOnly = true;
      if (key === "secure") options.secure = true;
      if (key === "samesite") {
        options.sameSite = attributeValue.toLowerCase() as ResponseCookie["sameSite"];
      }
      if (key === "max-age") options.maxAge = Number(attributeValue);
      if (key === "expires") options.expires = new Date(attributeValue);
    }
    store.set(name, value, options);
  }
}
