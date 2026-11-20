// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getCore, getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";

// Thin HTTP contract over the source-coverage route: an admitted shopper sees
// what a source is worth, an anonymous caller does not, and a malformed host is
// mapped to 400 by the shared error mapping.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const TOKEN = "source-coverage-setup-token";
const EMAIL = "sources-operator@example.nl";
const PASSWORD = "sources-operator-passphrase-1";

let db: Knex;
let setupClaim: typeof import("../app/api/setup/claim/route");
let signIn: typeof import("../app/api/sign-in/route");
let sourcesRoute: typeof import("../app/api/catalogue/sources/[host]/route");

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
  if (!session) throw new Error("no session cookie");
  return session.split(";")[0]!;
}

function get(host: string, cookie?: string): Promise<Response> {
  return sourcesRoute.GET(
    new Request(`http://localhost/api/catalogue/sources/${host}`, {
      headers: cookie ? { cookie } : {},
    }),
    { params: Promise.resolve({ host }) },
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "source-coverage-test-secret-0123456789";
  process.env.SETUP_TOKEN = TOKEN;
  process.env.INSTALLATION_SECRET = "source-coverage-installation-secret";

  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  setupClaim = await import("../app/api/setup/claim/route");
  signIn = await import("../app/api/sign-in/route");
  sourcesRoute = await import("../app/api/catalogue/sources/[host]/route");

  await setupClaim.POST(
    jsonRequest("http://localhost/api/setup/claim", {
      token: TOKEN,
      name: "Source Operator",
      email: EMAIL,
      password: PASSWORD,
      workspaceName: "Sources workspace",
    }),
  );

  // A recorded reading, as a successful ingest would leave behind.
  const observedAt = new Date("2026-11-19T10:00:00Z");
  await db("source_adapter_state").insert({
    host: "www.coolblue.nl",
    adapter_id: "coolblue",
    adapter_version: "2026.11.1",
    required_fields: JSON.stringify({ present: ["name", "price", "currency", "gtin"], missing: [] }),
    field_coverage: "complete",
    last_success_at: observedAt,
  });
  await db("source_access_blocks").insert({
    host: "www.bol.com",
    url: "https://www.bol.com/nl/nl/p/x/1/",
    reason: "rate-limited",
    signal: "http-429",
    status_code: 429,
    observed_at: observedAt,
    retry_after_at: new Date("2026-11-19T10:05:00Z"),
  });
});

afterAll(async () => {
  closeAuth();
  const { closeCore } = await import("@/lib/core");
  await closeCore();
  await db.destroy();
});

async function admittedCookie(): Promise<string> {
  const signedIn = await signIn.POST(
    jsonRequest("http://localhost/api/sign-in", { email: EMAIL, password: PASSWORD }),
  );
  return sessionCookieFrom(signedIn);
}

describe("GET /api/catalogue/sources/:host", () => {
  it("returns the recorded coverage for an admitted shopper", async () => {
    const cookie = await admittedCookie();
    const res = await get("www.coolblue.nl", cookie);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      host: "www.coolblue.nl",
      adapter: { id: "coolblue", version: "2026.11.1" },
      coverage: "complete",
      coveredFields: ["name", "price", "currency", "gtin"],
      lastSuccessAt: "2026-11-19T10:00:00.000Z",
      accessBlocks: [],
    });
  });

  it("shows an access block so a blocked source is visible, not hidden", async () => {
    const cookie = await admittedCookie();
    const res = await get("www.bol.com", cookie);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accessBlocks).toEqual([
      expect.objectContaining({ reason: "rate-limited", signal: "http-429", statusCode: 429 }),
    ]);
  });

  it("maps a malformed host to 400 through the shared error mapping", async () => {
    const cookie = await admittedCookie();
    const res = await get("not_a_host", cookie);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { kind: "invalid-input", field: "host", message: "host must be a DNS hostname" },
    });
  });

  it("refuses an anonymous caller", async () => {
    const res = await get("www.coolblue.nl");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { kind: "forbidden", capability: "workspace.read" },
    });
  });

  it("serves the same engine state the core writes", async () => {
    // The route is a thin adapter: it reads through the core, not its own SQL.
    const cookie = await admittedCookie();
    const res = await get("www.coolblue.nl", cookie);
    const body = await res.json();
    const stored = await getDb()("source_adapter_state").where({ host: "www.coolblue.nl" }).first();
    expect(body.adapter.version).toBe(stored.adapter_version);
    expect((await getCore().sources.coverage({ kind: "anonymous" }, "www.coolblue.nl"))).toMatchObject({
      ok: true,
      value: { coverage: body.coverage },
    });
  });
});
