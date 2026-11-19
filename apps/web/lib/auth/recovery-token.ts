// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";

/** Environment variable carrying the installation-held recovery token. */
export const ADMIN_RECOVERY_TOKEN_ENV = "ADMIN_RECOVERY_TOKEN";

export type RecoveryTokenSource =
  | { kind: "configured"; token: string }
  | { kind: "missing" };

/**
 * Reads the operator-held recovery token. It lives in the deployment's
 * environment, never in the database, so no signed-in user (and no request to
 * the web application) can mint one: recovery happens on the host, by the
 * person who operates the installation (docs/runbooks/administrator-recovery.md).
 */
export function readRecoveryToken(
  env: NodeJS.ProcessEnv = process.env,
): RecoveryTokenSource {
  const token = env[ADMIN_RECOVERY_TOKEN_ENV]?.trim();
  if (!token) return { kind: "missing" };
  return { kind: "configured", token };
}

/**
 * Reads the new password without putting it in the shell history or the
 * process arguments: `ADMIN_NEW_PASSWORD_FILE` names a file only the operator
 * can read, which is removed again after a successful recovery.
 */
export function readNewPassword(
  env: NodeJS.ProcessEnv = process.env,
): { kind: "configured"; password: string } | { kind: "missing" } | { kind: "invalid"; reason: string } {
  const path = env.ADMIN_NEW_PASSWORD_FILE?.trim();
  if (!path) return { kind: "missing" };
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return { kind: "invalid", reason: "ADMIN_NEW_PASSWORD_FILE could not be read" };
  }
  const password = contents.replace(/\r?\n$/, "");
  if (password.length < 10) {
    return { kind: "invalid", reason: "the new password must be at least 10 characters" };
  }
  return { kind: "configured", password };
}
