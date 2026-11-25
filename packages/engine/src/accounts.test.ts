import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, createIdentity, migrate } from "@shopping-assistant/database/testing";
import {
  AccountAlreadyExistsError,
  createAccounts,
  RegistrationClosedError,
  type Accounts,
} from "./accounts.ts";

let server: Database;

interface Installation {
  database: Database;
  accounts: Accounts;
  drop: () => Promise<void>;
}

async function createInstallation({
  bootstrapped = true,
  registrationOpen = true,
}: { bootstrapped?: boolean; registrationOpen?: boolean } = {}): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  if (bootstrapped) {
    await database("installation").insert({
      initial_admin_created_at: database.fn.now(),
      registration_open: registrationOpen,
    });
  }
  return { database, accounts: createAccounts({ database }), drop };
}

async function discard({ database, drop }: Installation): Promise<void> {
  await database.destroy();
  await drop();
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("account policy", () => {
  it("records an ordinary account for an identity that already exists", async () => {
    const installation = await createInstallation();
    const identityId = await createIdentity(installation.database, "shopper@example.com");

    const account = await installation.accounts.register({
      identityId,
      email: "shopper@example.com",
    });

    expect(account).toMatchObject({
      id: identityId,
      email: "shopper@example.com",
      role: "user",
    });
    expect(await installation.accounts.findByEmail("shopper@example.com")).toMatchObject({
      role: "user",
    });
    await discard(installation);
  });

  it("refuses registration when the installation has closed it", async () => {
    const installation = await createInstallation({ registrationOpen: false });
    const identityId = await createIdentity(installation.database, "shopper@example.com");

    await expect(
      installation.accounts.register({ identityId, email: "shopper@example.com" }),
    ).rejects.toThrow(RegistrationClosedError);
    expect(await installation.accounts.findByEmail("shopper@example.com")).toBeUndefined();
    await discard(installation);
  });

  it("treats registration as closed before an installation is bootstrapped", async () => {
    const installation = await createInstallation({ bootstrapped: false });

    expect(await installation.accounts.isRegistrationOpen()).toBe(false);
    await discard(installation);
  });

  it("never records two accounts for one identity", async () => {
    const installation = await createInstallation();
    const identityId = await createIdentity(installation.database, "shopper@example.com");
    await installation.accounts.register({ identityId, email: "shopper@example.com" });

    await expect(
      installation.accounts.register({ identityId, email: "shopper@example.com" }),
    ).rejects.toThrow(AccountAlreadyExistsError);
    await discard(installation);
  });

  it("records the bootstrap admin regardless of registration policy", async () => {
    const installation = await createInstallation({ registrationOpen: false });
    const identityId = await createIdentity(installation.database, "operator@example.com");

    const account = await installation.accounts.recordAdmin({
      identityId,
      email: "operator@example.com",
    });

    expect(account.role).toBe("admin");
    await discard(installation);
  });

  it("answers with no account for an unknown email", async () => {
    const installation = await createInstallation();

    expect(await installation.accounts.findByEmail("nobody@example.com")).toBeUndefined();
    await discard(installation);
  });

  it("cannot hold a profile without the identity it belongs to", async () => {
    const installation = await createInstallation();

    await expect(
      installation.database("profiles").insert({
        id: "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b11",
        email: "ghost@example.com",
      }),
    ).rejects.toThrow(/profiles_id_foreign/);
    await discard(installation);
  });
});
