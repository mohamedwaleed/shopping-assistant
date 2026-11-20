// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { getAuthTables } from "better-auth/db";
import { createDb, DEFAULT_TEST_DATABASE_URL, migrateFresh } from "@shopping/db";
import { knexAuthAdapter } from "@/lib/auth/knex-adapter";
import { createAuthOptions } from "@/lib/auth/server";

// Real-PostgreSQL verification of the Knex-backed Better Auth adapter: the
// schema the pinned library expects must match the Knex migration, and the
// adapter's atomic primitives must hold under concurrency (docs/adr/0010).
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const BASE_URL = "http://localhost:3000";

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
const SECRET = "knex-adapter-verification-secret-0123456789";

describe("Knex-backed Better Auth adapter on PostgreSQL", () => {
  let db: Knex;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await migrateFresh(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  function adapter() {
    return knexAuthAdapter({ db })(createAuthOptions({ db, baseURL: BASE_URL, secret: SECRET }));
  }

  async function reset(): Promise<void> {
    await db("session").delete();
    await db("account").delete();
    await db("user").delete();
    await db("verification").delete();
  }

  it("has Knex migrations covering every column the library requires", async () => {
    const tables = getAuthTables(createAuthOptions({ db, baseURL: BASE_URL, secret: SECRET }));
    const expected = Object.values(tables).map((table) => table.modelName).sort();
    expect(expected).toEqual(["account", "session", "user", "verification"]);

    for (const table of Object.values(tables)) {
      const columns = await db(table.modelName).columnInfo();
      const required = Object.keys(table.fields).map(snakeCase);
      expect(Object.keys(columns).sort()).toEqual(expect.arrayContaining(required.sort()));
    }

    const userColumns = await db("user").columnInfo();
    expect(userColumns.email?.nullable).toBe(false);
    expect(userColumns.email_verified?.nullable).toBe(false);
    const sessionColumns = await db("session").columnInfo();
    expect(sessionColumns.user_id?.nullable).toBe(false);
  });

  it("creates, reads, updates and deletes records through the adapter", async () => {
    await reset();
    const auth = adapter();

    const user = await auth.create<{ id: string }>({
      model: "user",
      data: {
        name: "Adapter Probe",
        email: "adapter-probe@example.nl",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(user.id).toBeTruthy();

    const stored = await db("user").where({ id: user.id }).first();
    expect(stored.email).toBe("adapter-probe@example.nl");

    const found = await auth.findOne<{ id: string }>({
      model: "user",
      where: [{ field: "email", value: "adapter-probe@example.nl" }],
    });
    expect(found?.id).toBe(user.id);

    const updated = await auth.update<{ name: string }>({
      model: "user",
      where: [{ field: "id", value: user.id }],
      update: { name: "Renamed" },
    });
    expect(updated?.name).toBe("Renamed");

    const all = await auth.findMany({ model: "user", where: [], limit: 10 });
    expect(all).toHaveLength(1);
    expect(await auth.count({ model: "user" })).toBe(1);

    await auth.delete({ model: "user", where: [{ field: "id", value: user.id }] });
    expect(await auth.count({ model: "user" })).toBe(0);
  });

  it("rolls back every write when a transaction fails", async () => {
    await reset();
    const auth = adapter();

    await expect(
      auth.transaction(async (trx) => {
        await trx.create({
          model: "user",
          data: {
            name: "Rolled Back",
            email: "rolled-back@example.nl",
            emailVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await auth.count({ model: "user" })).toBe(0);
  });

  it("consumes a single-use token exactly once under concurrent callers", async () => {
    await reset();
    const auth = adapter();
    const expiresAt = new Date(Date.now() + 60_000);
    const created = await auth.create({
      model: "verification",
      data: {
        identifier: "setup-token",
        value: "one-time-value",
        expiresAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    expect(created.id).toBeTruthy();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        auth.consumeOne({
          model: "verification",
          where: [{ field: "identifier", value: "setup-token" }],
        }),
      ),
    );
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(await auth.count({ model: "verification" })).toBe(0);
  });

  it("applies guarded increments atomically", async () => {
    await reset();
    const auth = adapter();
    const session = await auth.create({
      model: "session",
      data: {
        token: "session-token",
        userId: (
          await auth.create({
            model: "user",
            data: {
              name: "Counter",
              email: "counter@example.nl",
              emailVerified: false,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          })
        ).id,
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const incremented = await auth.incrementOne<Record<string, unknown>>({
      model: "session",
      where: [{ field: "id", value: session.id }],
      increment: {},
      set: { ipAddress: "203.0.113.7" },
    });
    expect(incremented?.ipAddress).toBe("203.0.113.7");
  });
});
