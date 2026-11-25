import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectDatabase,
  databaseUrlFromEnvironment,
  withSearchPath,
  type Database,
} from "@shopping-assistant/database";
import { createTestSchema, migrate } from "@shopping-assistant/database/testing";
import { createKnexAdapter } from "./adapter.ts";

let server: Database;

interface Installation {
  database: Database;
  adapter: ReturnType<ReturnType<typeof createKnexAdapter>>;
  drop: () => Promise<void>;
}

async function createInstallation(): Promise<Installation> {
  const { schema, drop } = await createTestSchema(server);
  const database = connectDatabase(withSearchPath(databaseUrlFromEnvironment(), schema));
  await migrate(database);
  return { database, adapter: createKnexAdapter(database)({}), drop };
}

async function discard({ database, drop }: Installation): Promise<void> {
  await database.destroy();
  await drop();
}

function user(id: string, email: string, name = email) {
  const now = new Date();
  return { id, email, name, emailVerified: false, createdAt: now, updatedAt: now };
}

/**
 * Creates a row with the id this test chose. The factory generates one when it
 * is allowed to, so rows are inserted directly, as Better Auth's own tables
 * expect them to be.
 */
async function createUser(
  database: Database,
  id: string,
  email: string,
): Promise<void> {
  await database("user").insert(user(id, email));
}

beforeAll(() => {
  server = connectDatabase(databaseUrlFromEnvironment());
});

afterAll(async () => {
  await server?.destroy();
});

describe("knex adapter for Better Auth", () => {
  it("creates and reads back a row by a unique field", async () => {
    const installation = await createInstallation();
    const { adapter } = installation;

    await createUser(installation.database, "u1", "shopper@example.com");
    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "email", value: "shopper@example.com" }],
    });

    expect(found).toMatchObject({ id: "u1", email: "shopper@example.com", emailVerified: false });
    await discard(installation);
  });

  it("returns null rather than throwing when nothing matches", async () => {
    const installation = await createInstallation();

    const found = await installation.adapter.findOne({
      model: "user",
      where: [{ field: "email", value: "nobody@example.com" }],
    });

    expect(found).toBeNull();
    await discard(installation);
  });

  it("applies comparison and membership operators", async () => {
    const installation = await createInstallation();
    const { adapter } = installation;
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    await createUser(installation.database, "u1", "shopper@example.com");

    const session = (id: string, token: string, expiresAt: Date) => ({
      id,
      token,
      userId: "u1",
      expiresAt,
      createdAt: past,
      updatedAt: past,
    });
    await installation.database("session").insert(session("s1", "live", future));
    await installation.database("session").insert(session("s2", "stale", past));

    const live = await adapter.findMany({
      model: "session",
      where: [{ field: "expiresAt", value: new Date(), operator: "gt" }],
      limit: 10,
    });
    const either = await adapter.findMany({
      model: "session",
      where: [{ field: "id", value: ["s1", "s2"], operator: "in" }],
      limit: 10,
    });

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ token: "live" });
    expect(either).toHaveLength(2);
    await discard(installation);
  });

  it("matches case-insensitively when asked to", async () => {
    const installation = await createInstallation();
    await installation.adapter.create({
      model: "user",
      data: user("u1", "Shopper@Example.com"),
    });

    const found = await installation.adapter.findOne({
      model: "user",
      where: [{ field: "email", value: "shopper@example.com", mode: "insensitive" }],
    });

    // The stored email is returned, so the case-insensitive match is what proved it.
    expect(found).toMatchObject({ email: "Shopper@Example.com" });
    await discard(installation);
  });

  it("updates one row, counts, and deletes", async () => {
    const installation = await createInstallation();
    const { adapter } = installation;
    await createUser(installation.database, "u1", "a@example.com");
    await createUser(installation.database, "u2", "b@example.com");

    const updated = await adapter.update({
      model: "user",
      where: [{ field: "id", value: "u1" }],
      update: { emailVerified: true },
    });
    const count = await adapter.count({ model: "user", where: [] });

    expect(updated).toMatchObject({ id: "u1", emailVerified: true });
    expect(count).toBe(2);

    await adapter.delete({ model: "user", where: [{ field: "id", value: "u1" }] });
    expect(await adapter.count({ model: "user", where: [] })).toBe(1);
    await discard(installation);
  });

  it("orders and pages results", async () => {
    const installation = await createInstallation();
    const { adapter } = installation;
    for (const id of ["a", "b", "c"]) {
      await createUser(installation.database, id, `${id}@example.com`);
    }

    const page = await adapter.findMany({
      model: "user",
      limit: 1,
      offset: 1,
      sortBy: { field: "email", direction: "asc" },
    });

    expect(page).toHaveLength(1);
    expect(page[0]).toMatchObject({ id: "b" });
    await discard(installation);
  });

  it("runs a callback inside one transaction, rolling back on failure", async () => {
    const installation = await createInstallation();
    const { adapter } = installation;

    await expect(
      adapter.transaction(async (trx) => {
        await trx.create({ model: "user", data: user("u1", "rolled-back@example.com") });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await adapter.count({ model: "user", where: [] })).toBe(0);
    await discard(installation);
  });

  it("refuses an OR-joined where clause instead of guessing", async () => {
    const installation = await createInstallation();

    await expect(
      installation.adapter.findMany({
        model: "user",
        where: [
          { field: "email", value: "a@example.com" },
          { field: "id", value: "u1", connector: "OR" },
        ],
        limit: 10,
      }),
    ).rejects.toThrow(/OR-joined/);
    await discard(installation);
  });
});
