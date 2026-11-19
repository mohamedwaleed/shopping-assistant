// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import { getCore, getDb } from "@/lib/core";
import { closeAuth, getAuth } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { startProviderFixtures, type ProviderFixture } from "./support/provider-fixtures";

// Ticket 32 over HTTP: the settings endpoint reports Claude plan availability
// honestly, in the same payload as the API-key configuration, and reading it
// costs nothing. No request is made to any provider and no plan credential is
// ever accepted, because there is no permitted route (docs/adr/0013).
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;

const TOKEN = "plan-access-setup-token";
const ADMIN_EMAIL = "operator-plan@example.nl";
const ADMIN_PASSWORD = "operator-plan-passphrase-1";
const ANTHROPIC_KEY = "sk-ant-api-plan-http-key-0001";

let db: Knex;
let fixtures: ProviderFixture;
let setupRoute: typeof import("../app/api/settings/models/route");
let testRoute: typeof import("../app/api/settings/models/test/route");
let claimRoute: typeof import("../app/api/setup/claim/route");
let signInRoute: typeof import("../app/api/sign-in/route");

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

beforeAll(async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.BETTER_AUTH_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "plan-access-test-secret-0123456789abcdef";
  process.env.INSTALLATION_SECRET = "plan-access-installation-secret-0123";
  process.env.SETUP_TOKEN = TOKEN;

  fixtures = await startProviderFixtures();
  db = createDb(TEST_DATABASE_URL);
  await db.migrate.rollback({}, true);
  await db.migrate.latest();

  setupRoute = await import("../app/api/settings/models/route");
  testRoute = await import("../app/api/settings/models/test/route");
  claimRoute = await import("../app/api/setup/claim/route");
  signInRoute = await import("../app/api/sign-in/route");
});

beforeEach(async () => {
  fixtures.reset();
  await db("workspace_model_settings").delete();
  await db("workspace_model_credentials").delete();
  await db("installation_model_settings").update({
    default_model: null,
    extraction_model: null,
    usage_source: null,
    capability_report: null,
    capability_tested_at: null,
  });
  await db("installation_model_credentials").delete();
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
  await fixtures.close();
  await db.destroy();
});

async function claimAdministrator(): Promise<string> {
  const res = await claimRoute.POST(
    jsonRequest("http://localhost/api/setup/claim", {
      token: TOKEN,
      name: "Ada Admin",
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      workspaceName: "Ada's workspace",
    }),
  );
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

async function provisionShopper(email: string, password: string, workspaceName: string) {
  const created = await createAccountProvisioner(getAuth(), getDb()).createCredentialAccount({
    name: "Sam Shopper",
    email,
    password,
  });
  const [workspace] = await db("workspaces")
    .insert({ name: workspaceName, created_by_user_id: created.userId })
    .returning("id");
  await db("workspace_memberships").insert({
    workspace_id: workspace.id,
    user_id: created.userId,
    role: "owner",
  });
  return { userId: created.userId, workspaceId: workspace.id as string };
}

async function signIn(email: string, password: string): Promise<string> {
  const res = await signInRoute.POST(jsonRequest("http://localhost/api/sign-in", { email, password }));
  expect(res.status).toBe(200);
  return sessionCookieFrom(res);
}

describe("Claude plan availability over HTTP", () => {
  it("reports approval-required beside the API-key configuration", async () => {
    const cookie = await claimAdministrator();
    const res = await setupRoute.GET(
      new Request("http://localhost/api/settings/models", { headers: { cookie } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.planAccess.state).toBe("approval-required");
    expect(body.planAccess.reason).toBe("app-registration-missing");
    expect(body.planAccess.checkedAt).toBe("2026-02-27");
    // Both published routes are reported, with the closed one named as such.
    expect(body.planAccess.routes).toEqual([
      expect.objectContaining({ route: "consumer-subscription", state: "unavailable" }),
      expect.objectContaining({ route: "linked-billing", state: "approval-required" }),
    ]);
    // The reason is traceable to official documentation, not asserted.
    expect(body.planAccess.sources.map((source: { url: string }) => source.url)).toContain(
      "https://code.claude.com/docs/en/legal-and-compliance",
    );
    // Reading availability never contacts a provider.
    expect(fixtures.requests).toEqual([]);
  });

  it("keeps Anthropic API-key mode working while plan access is unavailable", async () => {
    const cookie = await claimAdministrator();
    const saved = await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
          usageSource: "installation",
          extractionModel: null,
          apiKey: ANTHROPIC_KEY,
        },
        { cookie },
      ),
    );
    expect(saved.status).toBe(200);

    const read = await setupRoute.GET(
      new Request("http://localhost/api/settings/models", { headers: { cookie } }),
    );
    const text = await read.text();
    expect(text).not.toContain(ANTHROPIC_KEY);
    const body = JSON.parse(text);
    // The key is configured and serving, and the plan is still not permitted:
    // two independent facts the settings screen must show separately.
    expect(body.effective).toMatchObject({
      source: "installation",
      defaultModel: { provider: "anthropic" },
      credential: { source: "installation", masked: "sk-…001" },
    });
    expect(body.planAccess.state).toBe("approval-required");
  });

  it("shows availability to any admitted member and nobody else", async () => {
    await claimAdministrator();
    await provisionShopper("shopper-plan@example.nl", "shopper-passphrase-1", "Shopper workspace");
    const shopperCookie = await signIn("shopper-plan@example.nl", "shopper-passphrase-1");

    const member = await setupRoute.GET(
      new Request("http://localhost/api/settings/models", { headers: { cookie: shopperCookie } }),
    );
    expect(member.status).toBe(200);
    expect((await member.json()).planAccess.state).toBe("approval-required");

    const anonymous = await setupRoute.GET(new Request("http://localhost/api/settings/models"));
    expect(anonymous.status).toBe(403);
    expect((await anonymous.json()).error.kind).toBe("forbidden");
  });

  it("makes no plan request even when the diagnostic is run", async () => {
    const cookie = await claimAdministrator();
    // No model is configured, so the diagnostic refuses before any call: plan
    // access has no request path at all, permitted or otherwise.
    const res = await testRoute.POST(
      jsonRequest("http://localhost/api/settings/models/test", {}, { cookie }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ kind: "model-not-configured", role: "default" });
    expect(fixtures.requests).toEqual([]);
  });

  it("accepts no plan credential through the settings endpoint", async () => {
    const cookie = await claimAdministrator();
    // There is no field through which a subscription token could be supplied,
    // and an unrecognised one is ignored rather than stored.
    const saved = await setupRoute.PUT(
      jsonRequest(
        "http://localhost/api/settings/models",
        {
          defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
          usageSource: "installation",
          extractionModel: null,
          apiKey: ANTHROPIC_KEY,
          claudePlanToken: "sk-ant-oat01-subscription-token-should-be-ignored",
        },
        { cookie },
      ),
    );
    expect(saved.status).toBe(200);

    const stored = await db("installation_model_credentials").first();
    expect(stored.ciphertext).not.toContain("subscription-token");
    const read = await setupRoute.GET(
      new Request("http://localhost/api/settings/models", { headers: { cookie } }),
    );
    const text = await read.text();
    expect(text).not.toContain("subscription-token");
    expect(text).not.toContain("claudePlanToken");
  });
});
