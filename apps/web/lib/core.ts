// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  createSecretCipher,
  createShoppingCore,
  INSTALLATION_SECRET_ENV,
  MINIMUM_INSTALLATION_SECRET_LENGTH,
  type SecretCipher,
  type ShoppingCore,
} from "@shopping/core";
import { createDb, databaseUrl } from "@shopping/db";
import type { Knex } from "knex";
import {
  CHATGPT_PLAN_ENDPOINT_ENV,
  createAiSdkProbe,
  createChatGPTPlanExercise,
} from "@/lib/models/ai-sdk-probe";
import { createAiSdkExtractor } from "@/lib/models/ai-sdk-extraction";

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
      // Catalogue reading uses the installation's extraction model; core
      // resolves it and refuses rather than borrowing a workspace override.
      extraction: { extractor: createAiSdkExtractor() },
      // The plan exercise is the only place a provider SDK call is made for a
      // ChatGPT plan connection; core decides when it may run. The endpoint is
      // configuration (a self-hosted installation may not reach the public
      // route), so it is read once here and never taken from a request.
      planExercise: createChatGPTPlanExercise({
        ...(process.env[CHATGPT_PLAN_ENDPOINT_ENV]
          ? { baseUrl: process.env[CHATGPT_PLAN_ENDPOINT_ENV] }
          : {}),
      }),
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
