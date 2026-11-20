// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL, resetSchema } from "@shopping/db";
import { closeAuth } from "@/lib/auth/session";

// Thin HTTP contract checks for hardened ingestion. The adapter owns no logic:
// it resolves the session principal, passes the URL to the core, and maps the
// core error to a status. URL and source policy decisions are asserted at the
// core seam; here only the transport contract is checked.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "ingestion-http-setup-token";

let db: Knex;
let ingestRoute: typeof import("../app/api/catalogue/ingest/route");
let coverageRoute: typeof import("../app/api/catalogue/coverage/route");
let claimRoute: typeof import("../app/api/setup/claim/route");

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });
}

function sessionCookieFrom(response: Response): string {
  const session = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("better-auth.session_token="));
  if (!session) throw new Error("no session cookie issued");
  return session.split(";")[0]!;
}

async function claimAdministrator(): Promise<string> {
  const res = await claimRoute.POST(
    jsonRequest("http://localhost/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: "operator@example.nl",
      password: "operator-passphrase-1",
      workspaceName: "Ada's workspace",
    }),
  );
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "ingestion-http-test-secret-0123456789abcdef";
  process.env.INSTALLATION_SECRET = "ingestion-http-installation-secret-0123";
  process.env.SETUP_TOKEN = TOKEN;

  db = createDb(TEST_DATABASE_URL);
  await resetSchema(db);
  await db.migrate.latest();

  ingestRoute = await import("../app/api/catalogue/ingest/route");
  coverageRoute = await import("../app/api/catalogue/coverage/route");
  claimRoute = await import("../app/api/setup/claim/route");
});

beforeEach(async () => {
  await db("ingestion_sources").delete();
  await db("workspace_memberships").delete();
  await db("workspaces").delete();
  await db("session").delete();
  await db("account").delete();
  await db("user").delete();
  await db("installation").update({
    setup_completed_at: null,
    setup_token_hash: null,
    setup_administrator_user_id: null,
  });
});

afterAll(async () => {
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

describe("ingestion over HTTP", () => {
  it("maps an unsafe URL to 400 without retrieving it", async () => {
    const cookie = await claimAdministrator();
    const response = await ingestRoute.POST(
      jsonRequest("http://localhost/api/catalogue/ingest", { url: "http://169.254.169.254/latest/meta-data" }, { cookie }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({ kind: "unsafe-url" });
  });

  it("reports that no source policy permits the URL", async () => {
    const cookie = await claimAdministrator();
    for (const route of [ingestRoute, coverageRoute]) {
      const response = await route.POST(
        jsonRequest("http://localhost/api/catalogue/ingest", { url: "https://shop.example.test/products/sound-1" }, { cookie }),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatchObject({ kind: "source-not-permitted" });
    }
  });

  it("requires a session for ingestion and coverage", async () => {
    for (const route of [ingestRoute, coverageRoute]) {
      const response = await route.POST(
        jsonRequest("http://localhost/api/catalogue/ingest", { url: "https://shop.example.test/products/sound-1" }),
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error).toMatchObject({ kind: "forbidden", capability: "workspace.read" });
    }
  });
});
