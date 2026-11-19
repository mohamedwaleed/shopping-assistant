// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { getDb } from "@/lib/core";
import { createAccountProvisioner } from "@/lib/auth/provisioner";

// The operator-only administrator recovery route: a command run on the host,
// holding the deployment's recovery token. It is exercised here against real
// PostgreSQL through the same process entry point an operator uses, and it is
// checked to be the only way in: the web surface has no public override.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));
const RECOVERY_TOKEN = "operator-held-administrator-recovery-token";
const ADMIN_EMAIL = "operator@example.nl";
const ADMIN_PASSWORD = "operator-passphrase-1";
const NEW_PASSWORD = "recovered-passphrase-1";

let db: Knex;
let workdir: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the recovery command the way an operator does, with its own environment. */
function recover(
  email: string,
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", "scripts/admin-recover.ts", email],
      {
        cwd: APP_DIR,
        env: {
          ...process.env,
          DATABASE_URL: TEST_DATABASE_URL,
          BETTER_AUTH_SECRET: "recovery-command-test-secret-0123456789",
          BETTER_AUTH_URL: "http://localhost:3000",
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function seedAdministrator(): Promise<string> {
  const created = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
    name: "Ada Admin",
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  await db("installation").where({ id: 1 }).update({
    setup_completed_at: new Date(),
    setup_administrator_user_id: created.userId,
  });
  await db("session").insert({
    id: "recovery-test-session",
    token: "recovery-test-token",
    user_id: created.userId,
    expires_at: new Date(Date.now() + 60_000),
  });
  return created.userId;
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_SECRET = "recovery-command-test-secret-0123456789";
  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();
  await getDb().raw("select 1");
  workdir = mkdtempSync(join(tmpdir(), "admin-recovery-"));
});

beforeEach(async () => {
  await db("workspace_memberships").delete();
  await db("workspaces").delete();
  await db("session").delete();
  await db("account").delete();
  await db("user").delete();
  await db("installation").update({
    setup_completed_at: null,
    setup_token_hash: null,
    setup_administrator_user_id: null,
  });
});

afterAll(async () => {
  rmSync(workdir, { recursive: true, force: true });
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

describe("pnpm admin:recover", () => {
  it("replaces the administrator's password and revokes their sessions", async () => {
    const userId = await seedAdministrator();
    const passwordFile = join(workdir, "new-password.txt");
    writeFileSync(passwordFile, `${NEW_PASSWORD}\n`, { mode: 0o600 });

    const result = await recover(ADMIN_EMAIL, {
      ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      ADMIN_NEW_PASSWORD_FILE: passwordFile,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("password replaced");
    expect(result.stdout).toMatch(/\d+ sessions revoked/);
    // The password file is consumed, so it cannot linger on disk.
    expect(existsSync(passwordFile)).toBe(false);

    expect(await db("session").where({ user_id: userId })).toEqual([]);
    await expect(
      getAuth().api.signInEmail({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
    ).rejects.toThrow();
    await expect(
      getAuth().api.signInEmail({ body: { email: ADMIN_EMAIL, password: NEW_PASSWORD } }),
    ).resolves.toMatchObject({ user: { id: userId } });
  });

  it("refuses without the deployment's recovery token", async () => {
    await seedAdministrator();
    const passwordFile = join(workdir, "unused-password.txt");
    writeFileSync(passwordFile, `${NEW_PASSWORD}\n`, { mode: 0o600 });

    const result = await recover(ADMIN_EMAIL, {
      ADMIN_RECOVERY_TOKEN: undefined,
      ADMIN_NEW_PASSWORD_FILE: passwordFile,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ADMIN_RECOVERY_TOKEN");
    expect(existsSync(passwordFile)).toBe(true);
    await expect(
      getAuth().api.signInEmail({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
    ).resolves.toMatchObject({ user: { email: ADMIN_EMAIL } });
  });

  it("refuses an address that is not the installation administrator", async () => {
    await seedAdministrator();
    const shopper = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
      name: "Sam Shopper",
      email: "shopper@example.nl",
      password: ADMIN_PASSWORD,
    });
    const passwordFile = join(workdir, "shopper-password.txt");
    writeFileSync(passwordFile, `${NEW_PASSWORD}\n`, { mode: 0o600 });

    const result = await recover("shopper@example.nl", {
      ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      ADMIN_NEW_PASSWORD_FILE: passwordFile,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not-the-administrator");
    await expect(
      getAuth().api.signInEmail({ body: { email: "shopper@example.nl", password: ADMIN_PASSWORD } }),
    ).resolves.toMatchObject({ user: { id: shopper.userId } });
  });

  it("refuses an unknown address", async () => {
    await seedAdministrator();
    const passwordFile = join(workdir, "unknown-password.txt");
    writeFileSync(passwordFile, `${NEW_PASSWORD}\n`, { mode: 0o600 });

    const result = await recover("nobody@example.nl", {
      ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      ADMIN_NEW_PASSWORD_FILE: passwordFile,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown-address");
  });

  it("refuses a short password and keeps the old one working", async () => {
    await seedAdministrator();
    const passwordFile = join(workdir, "short-password.txt");
    writeFileSync(passwordFile, "short\n", { mode: 0o600 });

    const result = await recover(ADMIN_EMAIL, {
      ADMIN_RECOVERY_TOKEN: RECOVERY_TOKEN,
      ADMIN_NEW_PASSWORD_FILE: passwordFile,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("at least 10 characters");
    await expect(
      getAuth().api.signInEmail({ body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }),
    ).resolves.toMatchObject({ user: { email: ADMIN_EMAIL } });
  });
});
