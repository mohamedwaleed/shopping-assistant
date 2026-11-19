// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it } from "vitest";
import { expiredSessionCookies, sessionCookieOptions } from "@/lib/auth/cookies";

// The spec asks for secure HTTP-only database-backed sessions. Whether the
// identity library prefixes its cookies with `__Secure-` depends on how it was
// loaded, but the attributes this app writes are its own and must never be
// weaker than that: HttpOnly, SameSite=Lax and, in production, Secure.
const originalEnv = process.env.NODE_ENV;

function setNodeEnv(value: string): void {
  Object.assign(process.env, { NODE_ENV: value });
}

afterEach(() => {
  setNodeEnv(originalEnv ?? "test");
});

describe("session cookie attributes", () => {
  it("marks the cookie Secure in production", () => {
    setNodeEnv("production");
    expect(sessionCookieOptions()).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });
  });

  it("keeps HttpOnly and SameSite=Lax outside production without forcing Secure", () => {
    setNodeEnv("development");
    expect(sessionCookieOptions()).toEqual({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    });
  });

  it("clears every session cookie with the same protections in production", () => {
    setNodeEnv("production");
    const cookies = expiredSessionCookies();
    expect(cookies).toHaveLength(4);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Lax/);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/Max-Age=0/);
    }
  });

  it("clears session cookies without Secure outside production", () => {
    setNodeEnv("development");
    for (const cookie of expiredSessionCookies()) {
      expect(cookie).not.toMatch(/; Secure/);
      expect(cookie).toMatch(/Max-Age=0/);
    }
  });
});
