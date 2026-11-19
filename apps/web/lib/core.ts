// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createSecretCipher,
  createShoppingCore,
  INSTALLATION_SECRET_ENV,
  MINIMUM_INSTALLATION_SECRET_LENGTH,
  nodemailerTransport,
  type SecretCipher,
  type ShoppingCore,
} from "@shopping/core";
import { createDb, databaseUrl } from "@shopping/db";
import type { Knex } from "knex";
import { createAiSdkProbe } from "@/lib/models/ai-sdk-probe";

let db: Knex | undefined;
let core: ShoppingCore | undefined;

function getDb(): Knex {
  if (!db) {
    db = createDb(databaseUrl());
  }
  return db;
}

/**
 * The installation secret that encrypts provider credentials lives outside
 * PostgreSQL. A missing or short secret must not take down routes that never
 * touch credentials, so the cipher refuses per operation instead of throwing
 * while the core is built — the same failure the mailer reports.
 */
function modelCipher(): SecretCipher {
  const secret = process.env[INSTALLATION_SECRET_ENV];
  const usable = secret !== undefined && secret.trim().length >= MINIMUM_INSTALLATION_SECRET_LENGTH;
  const refuse = (): never => {
    throw new Error(
      `${INSTALLATION_SECRET_ENV} must be set to at least ${MINIMUM_INSTALLATION_SECRET_LENGTH} characters to store provider credentials`,
    );
  };
  if (!usable) {
    return {
      encryption: "aes-256-gcm",
      encrypt: refuse,
      decrypt: refuse,
    };
  }
  return createSecretCipher({ key: secret.trim() });
}

/** Per-process Knex pool + core engine; adapters stay thin over this. */
export function getCore(): ShoppingCore {
  if (!core) {
    core = createShoppingCore({
      db: getDb(),
      models: { cipher: modelCipher(), probe: createAiSdkProbe() },
      // Account links point back at this deployment, and transactional email
      // always goes through a real SMTP conversation.
      baseUrl: () => process.env.BETTER_AUTH_URL,
      mailTransport: nodemailerTransport(),
    });
  }
  return core;
}

export { getDb };

export async function closeCore(): Promise<void> {
  await db?.destroy();
  db = undefined;
  core = undefined;
}
