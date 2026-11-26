import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, createIdentity, migrate } from "@shopping-assistant/database/testing";
import {
  createAccounts,
  NotAnAdminError,
  PolicyRefusedError,
  type Accounts,
  type PolicyCeilings,
} from "./accounts.ts";
import { OFFERED_MODELS, offeredModels } from "./policy.ts";

let server: Database;

interface Installation {
  database: Database;
  accounts: Accounts;
  drop: () => Promise<void>;
}

/**
 * A bootstrapped installation whose operator offers only part of what the
 * application knows how to talk to, so a ceiling is actually in force.
 */
async function createInstallation(ceilings?: PolicyCeilings): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  await database.transaction(async (transaction) => {
    await transaction("installation").insert({
      initial_admin_created_at: transaction.fn.now(),
      registration_open: true,
    });
    const adminId = await createIdentity(transaction, "operator@example.com");
    await transaction("profiles").insert({
      id: adminId,
      email: "operator@example.com",
      role: "admin",
    });
  });
  return {
    database,
    accounts: createAccounts({ database, ...(ceilings ? { ceilings } : {}) }),
    drop,
  };
}

async function discard({ database, drop }: Installation): Promise<void> {
  await database.destroy();
  await drop();
}

async function operatorOf(installation: Installation): Promise<string> {
  const operator = await installation.accounts.findByEmail("operator@example.com");
  if (!operator) throw new Error("The fixture has no operator");
  return operator.id;
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("installation policy", () => {
  it("records the registration policy an admin chooses", async () => {
    const installation = await createInstallation();
    const actor = { id: await operatorOf(installation) };

    const closed = await installation.accounts.updatePolicy(actor, { registrationOpen: false });
    expect(closed.registrationOpen).toBe(false);
    expect(await installation.accounts.isRegistrationOpen()).toBe(false);

    const reopened = await installation.accounts.updatePolicy(actor, { registrationOpen: true });
    expect(reopened.registrationOpen).toBe(true);
    expect(await installation.accounts.isRegistrationOpen()).toBe(true);
    await discard(installation);
  });

  it("survives a restart because policy is a row, not process state", async () => {
    const installation = await createInstallation();
    const actor = { id: await operatorOf(installation) };
    await installation.accounts.updatePolicy(actor, { registrationOpen: false, modelId: "economy" });

    // A fresh engine over the same schema sees the policy the first one wrote.
    const reopened = createAccounts({ database: installation.database });
    expect(await reopened.policy()).toMatchObject({
      registrationOpen: false,
      modelId: "economy",
    });
    await discard(installation);
  });

  it("bumps a revision on every policy write so a reader can tell them apart", async () => {
    const installation = await createInstallation();
    const actor = { id: await operatorOf(installation) };

    const first = await installation.accounts.updatePolicy(actor, { registrationOpen: false });
    const second = await installation.accounts.updatePolicy(actor, { registrationOpen: true });

    expect(second.revision).toBe(first.revision + 1);
    await discard(installation);
  });

  it("refuses a policy change from an ordinary account", async () => {
    const installation = await createInstallation();
    const shopperId = await createIdentity(installation.database, "shopper@example.com");
    await installation.accounts.register({ identityId: shopperId, email: "shopper@example.com" });

    await expect(
      installation.accounts.updatePolicy({ id: shopperId }, { registrationOpen: false }),
    ).rejects.toThrow(NotAnAdminError);
    expect(await installation.accounts.isRegistrationOpen()).toBe(true);
    await discard(installation);
  });

  it("refuses a model that has no adapter, even with no ceiling configured", async () => {
    const installation = await createInstallation();
    const actor = { id: await operatorOf(installation) };

    await expect(
      installation.accounts.updatePolicy(actor, { modelId: "gpt-imaginary" }),
    ).rejects.toThrow(PolicyRefusedError);
    expect((await installation.accounts.policy()).modelId).toBeUndefined();
    await discard(installation);
  });

  it("refuses a policy change from an ordinary account", async () => {
    const installation = await createInstallation();
    const other = await createIdentity(installation.database, "other@example.com");
    await installation.accounts.register({ identityId: other, email: "other@example.com" });

    await expect(
      installation.accounts.updatePolicy({ id: other }, { registrationOpen: false }),
    ).rejects.toThrow(NotAnAdminError);
    expect((await installation.accounts.policy()).registrationOpen).toBe(true);
    await discard(installation);
  });

  it("refuses a model the deployment does not offer", async () => {
    const installation = await createInstallation({ modelIds: ["economy"] });
    const actor = { id: await operatorOf(installation) };

    await expect(
      installation.accounts.updatePolicy(actor, { modelId: "thorough" }),
    ).rejects.toThrow(PolicyRefusedError);
    // Nothing was written.
    expect((await installation.accounts.policy()).modelId).toBeUndefined();

    // The one offered model is accepted.
    const chosen = await installation.accounts.updatePolicy(actor, { modelId: "economy" });
    expect(chosen.modelId).toBe("economy");
    await discard(installation);
  });

  it("refuses registration changes when the deployment fixes the policy", async () => {
    const installation = await createInstallation({ registration: false });
    const actor = { id: await operatorOf(installation) };

    await expect(
      installation.accounts.updatePolicy(actor, { registrationOpen: false }),
    ).rejects.toThrow(PolicyRefusedError);
    expect(await installation.accounts.isRegistrationOpen()).toBe(true);
    await discard(installation);
  });

  it("lets an admin hand the model choice back to the operator", async () => {
    const installation = await createInstallation({ modelIds: ["economy"] });
    const actor = { id: await operatorOf(installation) };
    await installation.accounts.updatePolicy(actor, { modelId: "economy" });

    const cleared = await installation.accounts.updatePolicy(actor, { modelId: null });

    expect(cleared.modelId).toBeUndefined();
    await discard(installation);
  });
});

describe("offered models", () => {
  it("offers everything the application knows when the deployment sets no ceiling", () => {
    expect(offeredModels(undefined)).toEqual([...OFFERED_MODELS]);
  });

  it("narrows to the operator's ceiling and never widens it", () => {
    const offered = offeredModels(["economy", "not-a-real-model"]);

    expect(offered.map((model) => model.id)).toEqual(["economy"]);
    // An id the application has no adapter for is dropped, not invented.
    expect(offered.every((model) => OFFERED_MODELS.some((known) => known.id === model.id))).toBe(
      true,
    );
  });
});
