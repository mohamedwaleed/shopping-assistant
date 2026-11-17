// SPDX-License-Identifier: AGPL-3.0-or-later
import { createDb } from "./client";
import { databaseUrl } from "./config";
import { loadDevelopmentFixtures } from "./fixtures";

const command = process.argv[2];
const COMMANDS = ["migrate", "rollback", "fixtures", "ensure-test-db"];

if (!command || !COMMANDS.includes(command)) {
  console.error(`usage: cli.ts <${COMMANDS.join("|")}>`);
  process.exit(1);
}

if (command === "ensure-test-db") {
  // Tests use their own database; create it if it does not exist so the suite
  // also works on dev volumes that predate the Compose init script.
  const testUrl =
    process.env.DATABASE_URL_TEST ??
    "postgres://postgres:postgres@localhost:54329/shopping_assistant_test";
  const testDbName = new URL(testUrl).pathname.slice(1);
  const adminUrl = new URL(
    process.env.DATABASE_URL_ADMIN ?? testUrl,
  );
  adminUrl.pathname = "/postgres";
  const admin = createDb(adminUrl.toString());
  try {
    const exists = await admin
      .select(admin.raw("1"))
      .from("pg_database")
      .where("datname", testDbName)
      .first();
    if (!exists) {
      await admin.raw(`CREATE DATABASE "${testDbName}"`);
      console.log(`created database ${testDbName}`);
    } else {
      console.log(`database ${testDbName} already exists`);
    }
  } finally {
    await admin.destroy();
  }
  process.exit(0);
}

const db = createDb(databaseUrl());

try {
  switch (command) {
    case "migrate": {
      const [batch, names] = await db.migrate.latest();
      console.log(`migrations batch ${batch}: ${names.length} applied`);
      break;
    }
    case "rollback": {
      await db.migrate.rollback();
      console.log("migrations rolled back one batch");
      break;
    }
    case "fixtures": {
      await loadDevelopmentFixtures(db);
      console.log("development fixtures loaded");
      break;
    }
  }
} finally {
  await db.destroy();
}
