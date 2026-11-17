// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import {
  createDb,
  DEFAULT_TEST_DATABASE_URL,
  loadDevelopmentFixtures,
} from "../src/index";

// Real-PostgreSQL checks: migrations must be repeatable and development
// fixtures must stay clearly separated from live catalogue data.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

describe("catalogue schema on PostgreSQL", () => {
  let db: Knex;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it("applies migrations repeatably", async () => {
    await expect(db.migrate.latest()).resolves.not.toThrow();

    for (const table of [
      "products",
      "retailers",
      "variants",
      "offers",
      "price_observations",
    ]) {
      await expect(
        db.schema.withSchema("public").hasTable(table),
      ).resolves.toBe(true);
    }
  });

  it("loads the labelled development fixture idempotently", async () => {
    await loadDevelopmentFixtures(db);
    await loadDevelopmentFixtures(db);

    const product = await db("products")
      .where({ name: "Dell UltraSharp U2723QE" })
      .first();
    expect(product).toBeDefined();
    expect(product.is_development_fixture).toBe(true);

    const variantCount = await db("variants").count("* as count").first();
    expect(Number(variantCount?.count)).toBe(1);
  });
});
