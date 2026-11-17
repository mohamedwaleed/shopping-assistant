// SPDX-License-Identifier: AGPL-3.0-or-later
import { createShoppingCore, type ShoppingCore } from "@shopping/core";
import { createDb, databaseUrl } from "@shopping/db";
import type { Knex } from "knex";

let db: Knex | undefined;
let core: ShoppingCore | undefined;

function getDb(): Knex {
  if (!db) {
    db = createDb(databaseUrl());
  }
  return db;
}

/** Per-process Knex pool + core engine; adapters stay thin over this. */
export function getCore(): ShoppingCore {
  if (!core) {
    core = createShoppingCore({ db: getDb() });
  }
  return core;
}

export { getDb };

export async function closeCore(): Promise<void> {
  await db?.destroy();
  db = undefined;
  core = undefined;
}
