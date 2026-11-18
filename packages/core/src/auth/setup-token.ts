// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, timingSafeEqual } from "node:crypto";

/** Environment variable carrying the installation-held one-time setup token. */
export const SETUP_TOKEN_ENV = "SETUP_TOKEN";

export type SetupTokenSource =
  | { kind: "configured"; token: string }
  | { kind: "missing" };

/**
 * Reads the operator-held setup token. The token lives in the installation's
 * environment rather than the database, so an existing administrator (or an
 * application user) can never mint a second one.
 */
export function readSetupToken(env: NodeJS.ProcessEnv = process.env): SetupTokenSource {
  const token = env[SETUP_TOKEN_ENV]?.trim();
  if (!token) return { kind: "missing" };
  return { kind: "configured", token };
}

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of the presented token against the configured one. */
export function setupTokenMatches(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(a, b);
}
