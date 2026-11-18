// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Origin check for the account's own state-changing endpoints, matching what
 * the identity library already does for its routes: a request that carries a
 * session cookie must name a trusted origin, so a cross-site form cannot spend
 * the cookie. Requests without an Origin or Referer header (same-origin
 * navigations and non-browser clients) are allowed; the cookie is HttpOnly and
 * SameSite=Lax, which already keeps it off cross-site form posts.
 */
export function sameOriginRejected(request: Request): boolean {
  const presented = request.headers.get("origin") ?? request.headers.get("referer");
  if (!presented) return false;

  const expected = request.headers.get("host");
  if (!expected) return true;

  try {
    const origin = new URL(presented);
    return origin.host !== expected;
  } catch {
    return true;
  }
}
