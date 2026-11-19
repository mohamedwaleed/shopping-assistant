// SPDX-License-Identifier: AGPL-3.0-or-later
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import type { Knex } from "knex";
import { knexAuthAdapter } from "./knex-adapter";

export const SESSION_INACTIVITY_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;

const DEFAULT_DEVELOPMENT_SECRET =
  "development-only-secret-change-me-0123456789abcdef";

export interface AuthOptionsInput {
  db: Knex;
  baseURL?: string | undefined;
  secret?: string | undefined;
  debugLogs?: boolean | undefined;
}

/**
 * Email/password identity through Better Auth over the Knex adapter. Public
 * sign-up stays closed: the one-time setup claim creates the first
 * administrator and later users arrive through invitations (docs/adr/0009).
 * The HTTP surface does not expose the library's own sign-up route, which the
 * setup claim calls server-side only after the installation token is spent.
 * Sessions live in PostgreSQL and the cookie cache is off so every request is
 * checked against the stored session.
 */
export function createAuthOptions({ db, baseURL, secret, debugLogs }: AuthOptionsInput) {
  return {
    appName: "Shopping Assistant",
    ...(baseURL ? { baseURL } : {}),
    basePath: "/api/auth",
    secret: secret ?? process.env.BETTER_AUTH_SECRET ?? DEFAULT_DEVELOPMENT_SECRET,
    trustedOrigins: baseURL ? [baseURL] : [],
    database: knexAuthAdapter({ db, debugLogs: debugLogs ?? false }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    emailVerification: { sendOnSignUp: false, sendOnSignIn: false },
    session: {
      expiresIn: SESSION_INACTIVITY_SECONDS,
      updateAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    // Identity ids are UUIDs like the rest of the schema; the session id stays
    // library-generated, so a signed cookie identifies exactly one stored row.
    advanced: { database: { generateId: "uuid" as const } },
    plugins: [nextCookies()],
  } satisfies BetterAuthOptions;
}

export function createAuth(input: AuthOptionsInput) {
  return betterAuth(createAuthOptions(input));
}

export type ShoppingAuth = ReturnType<typeof createAuth>;
