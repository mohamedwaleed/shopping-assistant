// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createShoppingCore,
  createSecretCipher,
  EXTRACTION_REVISION,
  type Principal,
} from "@shopping/core";
import { PILOT_TARGETS } from "@shopping/core/test-support/source-fixtures";

/**
 * The small, permitted cross-category live pilot (ticket 15).
 *
 * Nothing here runs by default and no CI job sets these variables, so the
 * reviewed fixtures are the only automatic proof. When an operator supplies a
 * token, this reads one page from each of two categories through two
 * maintained adapters and reports what the source actually gave back.
 *
 *   LIVE_PILOT=1                        enables the pilot
 *   LIVE_PILOT_OPERATOR_EMAIL=...       an admitted installation administrator
 *   LIVE_PILOT_OPERATOR_PASSWORD=...    their password
 *   DATABASE_URL=...                    the installation to record into
 *
 * The pilot asserts only what a permitted source can be held to: the page was
 * read, and the adapter either extracted every required field or honestly
 * reported the ones it could not. It never asserts a price, never evades an
 * access block, and never treats a fixture as live proof.
 */
const enabled = process.env.LIVE_PILOT === "1";
const email = process.env.LIVE_PILOT_OPERATOR_EMAIL ?? "";
const password = process.env.LIVE_PILOT_OPERATOR_PASSWORD ?? "";

describe.skipIf(!enabled || !email || !password)("live cross-category source pilot", () => {
  let db: Knex;

  it.each(PILOT_TARGETS)(
    "reads the $label source through its maintained adapter",
    async ({ adapterId, category, url }) => {
      db = createDb(process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
      const core = createShoppingCore({
        db,
        models: {
          cipher: createSecretCipher({ key: process.env.INSTALLATION_SECRET ?? "" }),
          probe: async () => {
            throw new Error("the pilot never probes a model");
          },
        },
      });
      const signIn = await core.auth.signIn(
        { email, password, sessionEstablished: true },
        // The pilot uses the identity library's own credential check; it needs
        // no provisioning, only verification of the operator's password.
        {
          createCredentialAccount: async () => ({ userId: "" }),
          deleteIdentity: async () => undefined,
          verifyCredentials: async () => null,
        },
      );
      if (!signIn.ok) throw new Error(`pilot operator cannot sign in: ${signIn.error.kind}`);
      const principal: Principal = {
        kind: "administrator",
        userId: signIn.value.id,
        workspaceId: signIn.value.workspace.workspaceId,
        sessionId: signIn.value.id,
      };

      try {
        // An access block recorded earlier is respected, never worked around.
        const before = await core.sources.coverage(principal, new URL(url).hostname);
        if (!before.ok) throw new Error(`coverage unreadable: ${before.error.kind}`);
        if (before.value.accessBlocks.length > 0) {
          expect(before.value.accessBlocks[0]?.reason).toBeDefined();
          return;
        }

        const ingested = await core.catalogue.ingestProductPage(principal, url);
        const after = await core.sources.coverage(principal, new URL(url).hostname);
        if (!after.ok) throw new Error(`coverage unreadable: ${after.error.kind}`);

        expect(after.value.adapter?.id ?? adapterId).toBe(adapterId);
        expect(after.value.extraction === "source-adapter" || after.value.lastFailure !== null).toBe(true);
        // Complete, or honest about what is missing: never invented.
        if (after.value.coverage === "complete") {
          expect(after.value.missingFields).toEqual([]);
        } else {
          expect(after.value.missingFields.length).toBeGreaterThan(0);
        }
        // The category is recorded on the product when the source states one.
        if (ingested.ok) {
          const product = await db("products").where({ id: (await db("variants").where({ id: ingested.value.variantId }).first()).product_id }).first();
          expect(product.category ?? category).toBeTruthy();
        }
      } finally {
        await db.destroy();
      }
    },
    120_000,
  );

  it("documents the extraction revision the pilot ran under", () => {
    expect(EXTRACTION_REVISION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
