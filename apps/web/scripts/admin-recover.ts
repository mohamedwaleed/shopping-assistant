// SPDX-License-Identifier: AGPL-3.0-or-later
import { rmSync } from "node:fs";
import { createDb } from "@shopping/db";
import { createAuth } from "@/lib/auth/server";
import { createCredentialChanger } from "@/lib/auth/credentials";
import { readNewPassword, readRecoveryToken } from "@/lib/auth/recovery-token";
import { decideRecovery, type RecoveryDecision } from "@/lib/auth/recovery";

/**
 * Operator-only administrator recovery, run on the host that serves the
 * installation: `pnpm admin:recover <email>` with ADMIN_RECOVERY_TOKEN and
 * ADMIN_NEW_PASSWORD_FILE in the deployment's environment
 * (docs/runbooks/administrator-recovery.md). There is no HTTP route for this,
 * so nothing reachable from a browser can override a password without the
 * mailbox or the old password.
 */
async function main(): Promise<number> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) {
    console.error("usage: pnpm admin:recover <administrator-email>");
    return 2;
  }

  const token = readRecoveryToken();
  if (token.kind === "missing") {
    console.error(
      "refused: ADMIN_RECOVERY_TOKEN is not set for this deployment, so recovery is unavailable",
    );
    return 1;
  }
  const password = readNewPassword();
  if (password.kind !== "configured") {
    console.error(
      password.kind === "missing"
        ? "refused: set ADMIN_NEW_PASSWORD_FILE to a file containing the new password"
        : `refused: ${password.reason}`,
    );
    return 1;
  }

  const db = createDb(process.env.DATABASE_URL ?? "");
  try {
    const installation = await db("installation").where({ id: 1 }).first();
    const user = await db("user").where({ email }).first();
    const decision: RecoveryDecision = decideRecovery(
      { email, newPassword: password.password },
      {
        configuredToken: token.token,
        presentedToken: token.token,
        user: user ? { id: user.id as string, email: user.email as string } : null,
        administratorUserId: installation?.setup_administrator_user_id ?? null,
        sessionCount: user
          ? Number((await db("session").where({ user_id: user.id }).count({ count: "*" }).first())?.count ?? 0)
          : 0,
      },
    );
    if (decision.kind === "refused") {
      console.error(`refused: ${decision.reason}`);
      return 1;
    }

    const auth = createAuth({
      db,
      baseURL: process.env.BETTER_AUTH_URL,
      secret: process.env.BETTER_AUTH_SECRET,
    });
    await createCredentialChanger(auth, db, { cookie: null }).setPassword({
      userId: decision.userId,
      newPassword: password.password,
    });
    // Whoever held the old password loses every session with it.
    await db("session").where({ user_id: decision.userId }).delete();
    console.log(
      `recovered ${email}: password replaced, ${decision.sessionsRevoked} sessions revoked`,
    );
    if (process.env.ADMIN_NEW_PASSWORD_FILE) rmSync(process.env.ADMIN_NEW_PASSWORD_FILE);
    return 0;
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main();
