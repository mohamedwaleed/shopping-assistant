import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, listAccounts, migrate } from "@shopping-assistant/database/testing";
import { createEngine, SetupClosedError, SetupTokenRejectedError, type Engine } from "./index.ts";
import { createFakeIdentityStore } from "./testing/fake-identity-store.ts";

const SETUP_TOKEN = "setup-token-0f9c1c1e4b6d4a51a2c3f0e5d7b8a9c6";
const PASSWORD = "correct-horse-battery-staple";
const run = promisify(execFile);
const attemptSetupScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "testing",
  "attempt-setup.ts",
);

interface Installation {
  database: Database;
  engine: Engine;
  identity: ReturnType<typeof createFakeIdentityStore>;
  schema: string;
  drop: () => Promise<void>;
}

let server: Database;

/** A fresh installation, because bootstrap closes it for every later attempt. */
async function createInstallation(): Promise<Installation> {
  const connection = databaseUrlFromEnvironment();
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(connection, schema));
  await migrate(database);
  const identity = createFakeIdentityStore();
  return {
    database,
    engine: createEngine({ database, setupToken: SETUP_TOKEN, identity }),
    identity,
    schema,
    drop,
  };
}

async function discardInstallation({ database, drop }: Installation): Promise<void> {
  await database.destroy();
  await drop();
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("installation bootstrap", () => {
  let installation: Installation;

  beforeAll(async () => {
    installation = await createInstallation();
  });

  afterAll(async () => {
    await discardInstallation(installation);
  });

  it("creates the first admin when the operator's setup token is submitted", async () => {
    const adminUser = await installation.engine.setup.complete({
      setupToken: SETUP_TOKEN,
      email: "operator@example.com",
      password: PASSWORD,
    });

    expect(adminUser).toEqual({ email: "operator@example.com", role: "admin" });
    expect(installation.identity.passwordOf("operator@example.com")).toBe(PASSWORD);
  });

  it("creates no admin and echoes nothing when the setup token is invalid", async () => {
    const fresh = await createInstallation();
    const submitted = "wrong-token-7c2d1b9a8f4e4d3c2b1a0f9e8d7c6b5a";

    const rejection = await fresh.engine.setup
      .complete({ setupToken: submitted, email: "intruder@example.com", password: PASSWORD })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(SetupTokenRejectedError);
    expect((rejection as Error).message).not.toContain(submitted);
    expect(await listAccounts(fresh.database)).toEqual([]);
    await discardInstallation(fresh);
  });

  it("creates exactly one admin when two valid requests arrive at once", async () => {
    const fresh = await createInstallation();
    const otherEngine = createEngine({
      database: fresh.database,
      setupToken: SETUP_TOKEN,
      identity: createFakeIdentityStore(),
    });

    const attempts = await Promise.allSettled([
      otherEngine.setup.complete({
        setupToken: SETUP_TOKEN,
        email: "first@example.com",
        password: PASSWORD,
      }),
      fresh.engine.setup.complete({
        setupToken: SETUP_TOKEN,
        email: "second@example.com",
        password: PASSWORD,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.any(SetupClosedError) }),
    ]);
    expect(await listAccounts(fresh.database)).toHaveLength(1);
    expect((await listAccounts(fresh.database))[0]?.role).toBe("admin");
    await discardInstallation(fresh);
  });

  it("stays closed once the initial admin exists, even for the operator's token", async () => {
    await expect(
      installation.engine.setup.complete({
        setupToken: SETUP_TOKEN,
        email: "second-admin@example.com",
        password: PASSWORD,
      }),
    ).rejects.toThrow(SetupClosedError);

    expect(await listAccounts(installation.database)).toEqual([
      { email: "operator@example.com", role: "admin", disabled: false },
    ]);
  });

  it("refuses to leave the installation without an active admin", async () => {
    const fresh = await createInstallation();
    await fresh.engine.setup.complete({
      setupToken: SETUP_TOKEN,
      email: "operator@example.com",
      password: PASSWORD,
    });

    // Deleting every account would leave the installation unadministered, so
    // the database refuses the delete itself rather than allowing a state that
    // a later bootstrap would have to repair.
    await expect(fresh.database("profiles").delete()).rejects.toThrow(/active admin/);
    await expect(fresh.database("user").delete()).rejects.toThrow(/active admin/);
    expect(await listAccounts(fresh.database)).toHaveLength(1);
    await discardInstallation(fresh);
  });

  it("stays closed for a process that starts after setup finished", async () => {
    const { stdout } = await run(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", attemptSetupScript, "restarted@example.com"],
      {
        env: {
          ...process.env,
          DATABASE_URL: databaseUrlFromEnvironment(),
          DATABASE_SCHEMA: installation.schema,
          SETUP_TOKEN,
        },
      },
    );

    expect(JSON.parse(stdout)).toEqual({ outcome: "closed" });
    expect(await listAccounts(installation.database)).toEqual([
      { email: "operator@example.com", role: "admin", disabled: false },
    ]);
  });

  it("reports which capabilities are configured without revealing any secret", async () => {
    const secret = "sk-live-3f9a2b7c1d8e4f6a0b5c9d2e7f1a3b8c";
    const unconfigured = await createInstallation();
    const configured = createEngine({
      database: unconfigured.database,
      setupToken: SETUP_TOKEN,
      identity: createFakeIdentityStore(),
      services: {
        email: { smtpUrl: "smtps://operator:smtp-password-41f7@mail.example.com:465" },
        model: { apiKey: secret },
        discovery: { searxngUrl: "http://searxng:8080" },
      },
    });

    const report = await configured.setup.readiness();

    expect(report).toEqual({
      database: "ready",
      email: "ready",
      model: "ready",
      discovery: "ready",
      setup: "open",
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).not.toContain("smtp-password-41f7");
    await discardInstallation(unconfigured);
  });

  it("reports missing external services as unconfigured rather than failing setup", async () => {
    const fresh = await createInstallation();

    const report = await fresh.engine.setup.readiness();

    expect(report).toEqual({
      database: "ready",
      email: "unconfigured",
      model: "unconfigured",
      discovery: "unconfigured",
      setup: "open",
    });
    await expect(
      fresh.engine.setup.complete({
        setupToken: SETUP_TOKEN,
        email: "operator@example.com",
        password: PASSWORD,
      }),
    ).resolves.toEqual({ email: "operator@example.com", role: "admin" });
    await discardInstallation(fresh);
  });
});
