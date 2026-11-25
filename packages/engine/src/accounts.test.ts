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
  AccountNotFoundError,
  createAccounts,
  LastAdminProtectedError,
  NotAnAdminError,
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
    // An installation always exists with at least one active admin, and the
    // database refuses any other state, so the fixture records both.
    await database.transaction(async (transaction) => {
      await transaction("installation").insert({
        initial_admin_created_at: transaction.fn.now(),
        registration_open: registrationOpen,
      });
      const adminId = await createIdentity(transaction, "operator@example.com");
      await transaction("profiles").insert({
        id: adminId,
        email: "operator@example.com",
        role: "admin",
      });
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
    const identityId = await createIdentity(installation.database, "second-operator@example.com");

    const account = await installation.accounts.recordAdmin({
      identityId,
      email: "second-operator@example.com",
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

/** The bootstrap admin's id, so administration can be exercised by an admin. */
async function operatorOf(installation: Installation): Promise<string> {
  const operator = await installation.accounts.findByEmail("operator@example.com");
  if (!operator) throw new Error("The fixture has no operator");
  return operator.id;
}

/** An ordinary account, ready to be promoted or disabled. */
async function shopperOf(installation: Installation, email = "shopper@example.com"): Promise<string> {
  const identityId = await createIdentity(installation.database, email);
  await installation.accounts.register({ identityId, email });
  return identityId;
}

describe("installation administration", () => {
  it("lets an admin promote an ordinary account", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const shopper = await shopperOf(installation);

    const promoted = await installation.accounts.promote({ id: operator }, shopper);

    expect(promoted).toMatchObject({ id: shopper, role: "admin" });
    expect((await installation.accounts.findByIdentity(shopper))?.role).toBe("admin");
    await discard(installation);
  });

  it("rejects every admin-only operation from an ordinary account", async () => {
    const installation = await createInstallation();
    const shopper = await shopperOf(installation);
    const other = await shopperOf(installation, "other@example.com");
    const actor = { id: shopper };

    // Each attempt is refused with the same error, so a rejected caller cannot
    // learn which operations exist or what they would have touched.
    await expect(installation.accounts.list(actor)).rejects.toThrow(NotAnAdminError);
    await expect(installation.accounts.promote(actor, other)).rejects.toThrow(NotAnAdminError);
    await expect(installation.accounts.demote(actor, other)).rejects.toThrow(NotAnAdminError);
    await expect(installation.accounts.disable(actor, other)).rejects.toThrow(NotAnAdminError);
    await expect(installation.accounts.enable(actor, other)).rejects.toThrow(NotAnAdminError);
    await expect(
      installation.accounts.updatePolicy(actor, { registrationOpen: false }),
    ).rejects.toThrow(NotAnAdminError);

    // Nothing changed.
    expect((await installation.accounts.findByIdentity(other))?.role).toBe("user");
    expect((await installation.accounts.findByIdentity(other))?.disabled).toBe(false);
    expect(await installation.accounts.isRegistrationOpen()).toBe(true);
    await discard(installation);
  });

  it("refuses administration to a disabled admin", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const second = await shopperOf(installation, "second@example.com");
    await installation.accounts.promote({ id: operator }, second);
    await installation.accounts.disable({ id: operator }, second);

    // A disabled admin keeps its role but loses its authority.
    await expect(installation.accounts.list({ id: second })).rejects.toThrow(NotAnAdminError);
    await discard(installation);
  });

  it("demotes an admin while another active admin remains", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const second = await shopperOf(installation, "second@example.com");
    await installation.accounts.promote({ id: operator }, second);

    const demoted = await installation.accounts.demote({ id: operator }, second);

    expect(demoted.role).toBe("user");
    expect((await installation.accounts.findByIdentity(operator))?.role).toBe("admin");
    await discard(installation);
  });

  it("refuses to demote, disable or delete the installation's last active admin", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const actor = { id: operator };

    await expect(installation.accounts.demote(actor, operator)).rejects.toThrow(
      LastAdminProtectedError,
    );
    await expect(installation.accounts.disable(actor, operator)).rejects.toThrow(
      LastAdminProtectedError,
    );
    // The database refuses the state itself, so even a write that bypasses the
    // engine cannot remove the last admin.
    await expect(installation.database("profiles").delete()).rejects.toThrow(/active admin/);
    expect((await installation.accounts.findByIdentity(operator))?.role).toBe("admin");
    expect((await installation.accounts.findByIdentity(operator))?.disabled).toBe(false);
    await discard(installation);
  });

  it("keeps an active admin when two admins demote each other at once", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const second = await shopperOf(installation, "second@example.com");
    await installation.accounts.promote({ id: operator }, second);

    // Each request is authorised by a live admin, so neither is rejected on
    // authority when it starts: the outcome is decided by the database, which
    // will not commit a state with no active admin left. Whichever request
    // loses does so either because its own authority went away first or because
    // the commit was refused, so both refusals are acceptable.
    const attempts = await Promise.allSettled([
      installation.accounts.demote({ id: operator }, second),
      installation.accounts.demote({ id: second }, operator),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    for (const attempt of attempts) {
      if (attempt.status !== "rejected") continue;
      // Whichever request loses does so either because the other transaction
      // demoted it first, or because its commit was refused by the database.
      // Both are legitimate; what must hold is that one active admin survives.
      expect(attempt.reason).toBeInstanceOf(Error);
      expect(
        attempt.reason instanceof LastAdminProtectedError ||
          attempt.reason instanceof NotAnAdminError ||
          attempt.reason instanceof AccountNotFoundError,
      ).toBe(true);
    }
    // Whatever the ordering, one active admin survives. The table is read
    // directly because the losing request may have demoted the caller that
    // would otherwise be authorised to list accounts.
    const survivors = await installation.database("profiles")
      .where({ role: "admin", disabled: false })
      .select("id");
    expect(survivors).toHaveLength(1);
    await discard(installation);
  });

  it("keeps an active admin when two admins disable each other at once", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const second = await shopperOf(installation, "second@example.com");
    await installation.accounts.promote({ id: operator }, second);

    const attempts = await Promise.allSettled([
      installation.accounts.disable({ id: operator }, second),
      installation.accounts.disable({ id: second }, operator),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const admins = (await installation.accounts.list({ id: operator })).filter(
      (account) => account.role === "admin" && !account.disabled,
    );
    expect(admins).toHaveLength(1);
    await discard(installation);
  });

  it("disables an account, ends its sessions, and re-enables it", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);
    const shopper = await shopperOf(installation);
    await installation.database("session").insert({
      id: "session-1",
      token: "token-1",
      userId: shopper,
      expiresAt: installation.database.raw("now() + interval '1 day'"),
      createdAt: installation.database.fn.now(),
      updatedAt: installation.database.fn.now(),
    });

    const disabled = await installation.accounts.disable({ id: operator }, shopper);

    expect(disabled.disabled).toBe(true);
    expect(await installation.database("session").where({ userId: shopper })).toHaveLength(0);

    const enabled = await installation.accounts.enable({ id: operator }, shopper);
    expect(enabled.disabled).toBe(false);
    await discard(installation);
  });

  it("answers not-found rather than revealing an account outside the caller's reach", async () => {
    const installation = await createInstallation();
    const operator = await operatorOf(installation);

    await expect(
      installation.accounts.promote({ id: operator }, "6b2f6c1e-0d6a-4f37-9a5c-2d0f8f7c1b11"),
    ).rejects.toThrow(AccountNotFoundError);
    await discard(installation);
  });
});
