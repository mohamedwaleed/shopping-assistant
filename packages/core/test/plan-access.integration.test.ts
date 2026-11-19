// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  CLAUDE_PLAN_ROUTES,
  createModelRegistry,
  createSecretCipher,
  planAccessView,
  type ModelRegistry,
  type PlanAccessRoute,
  type Principal,
} from "../src/index";

// Ticket 32: Claude plan availability is reported honestly. There is no
// permitted route for a consumer subscription to be spent by this app
// (docs/adr/0013), so the state must never read "supported" without evidence,
// must be readable by any admitted member, and must not disturb API-key mode.
const TEST_DATABASE_URL = process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const INSTALLATION_SECRET = "installation-secret-0123456789abcdef";

const ADMIN = "plan-admin-user";
const ADMIN_WORKSPACE = "33333333-3333-4333-8333-333333333333";
const SHOPPER = "plan-shopper-user";
const SHOPPER_WORKSPACE = "44444444-4444-4444-8444-444444444444";
const STRANGER = "plan-stranger-user";
const STRANGER_WORKSPACE = "55555555-5555-4555-8555-555555555555";

const administrator: Principal = {
  kind: "administrator",
  userId: ADMIN,
  workspaceId: ADMIN_WORKSPACE,
  sessionId: "plan-test-admin-session",
};
const shopper: Principal = {
  kind: "workspace",
  userId: SHOPPER,
  workspaceId: SHOPPER_WORKSPACE,
  sessionId: "plan-test-shopper-session",
};
/** Signed in, but a member of no workspace: nothing may be read for them. */
const stranger: Principal = {
  kind: "workspace",
  userId: STRANGER,
  workspaceId: STRANGER_WORKSPACE,
  sessionId: "plan-test-stranger-session",
};
const anonymous: Principal = { kind: "anonymous" };

const anthropicTarget = { provider: "anthropic" as const, modelId: "claude-sonnet-4-5" };

async function seedUsers(db: Knex): Promise<void> {
  await db("user").insert([
    { id: ADMIN, name: "Ada Admin", email: "ada-plan@example.nl" },
    { id: SHOPPER, name: "Sam Shopper", email: "sam-plan@example.nl" },
    { id: STRANGER, name: "Sid Stranger", email: "sid-plan@example.nl" },
  ]);
  await db("workspaces").insert([
    { id: ADMIN_WORKSPACE, name: "Admin workspace", created_by_user_id: ADMIN },
    { id: SHOPPER_WORKSPACE, name: "Shopper workspace", created_by_user_id: SHOPPER },
  ]);
  await db("workspace_memberships").insert([
    { workspace_id: ADMIN_WORKSPACE, user_id: ADMIN, role: "owner" },
    { workspace_id: SHOPPER_WORKSPACE, user_id: SHOPPER, role: "owner" },
  ]);
}

function probeCalls() {
  const calls: unknown[] = [];
  return {
    calls,
    probe: async () => {
      calls.push("probe");
      throw new Error("plan availability must never contact a provider");
    },
  };
}

describe("Claude plan availability through the core", () => {
  let db: Knex;
  let registry: ModelRegistry;
  let probe: ReturnType<typeof probeCalls>;

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL);
    await db.migrate.rollback({}, true);
    await db.migrate.latest();
  });

  beforeEach(async () => {
    await db("workspace_model_settings").delete();
    await db("workspace_model_credentials").delete();
    await db("installation_model_settings").delete();
    await db("installation_model_credentials").delete();
    await db("workspace_memberships").delete();
    await db("workspaces").delete();
    await db("user").delete();
    await seedUsers(db);
    probe = probeCalls();
    registry = createModelRegistry({
      db,
      cipher: createSecretCipher({ key: INSTALLATION_SECRET }),
      probe: probe.probe as never,
      now: () => new Date("2026-11-18T10:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe("the shipped declaration", () => {
    it("claims no supported route and names why each is closed", async () => {
      const view = planAccessView(CLAUDE_PLAN_ROUTES);

      // No consumer-subscription route can be reported as working.
      expect(view.state).not.toBe("supported");
      expect(view.state).toBe("approval-required");
      // The reason shown is the one behind the winning route, so the panel can
      // name the single thing standing between this installation and plan use.
      expect(view.reason).toBe("app-registration-missing");

      const [subscription, linkedBilling] = view.routes;
      expect(subscription).toMatchObject({
        route: "consumer-subscription",
        state: "unavailable",
        reason: "third-party-apps-prohibited",
        credential: "subscription-oauth",
      });
      // The one route that could carry plan value still excludes plans and
      // needs an app registration this installation does not hold.
      expect(linkedBilling).toMatchObject({
        route: "linked-billing",
        state: "approval-required",
        reason: "app-registration-missing",
        credential: "console-api-key",
      });
      expect(view.sources.length).toBeGreaterThanOrEqual(3);
      expect(view.sources.every((source) => source.url.startsWith("https://"))).toBe(true);
      expect(view.checkedAt).toBe("2026-02-27");
    });

    it("reports unavailable, not approval-required, when every route is closed", () => {
      const closed: PlanAccessRoute[] = CLAUDE_PLAN_ROUTES.map((route) => ({
        ...route,
        state: "unavailable" as const,
      }));
      expect(planAccessView(closed).state).toBe("unavailable");
    });
  });

  describe("supported needs evidence", () => {
    it("refuses to report supported without a permitted route and approval reference", () => {
      const unevidenced: PlanAccessRoute[] = [
        {
          route: "linked-billing",
          state: "supported",
          reason: "app-registered",
          credential: "console-api-key",
          // No evidence at all.
        },
      ];
      // A claim of support without evidence is downgraded, never believed.
      expect(planAccessView(unevidenced).state).not.toBe("supported");

      const partial: PlanAccessRoute[] = [
        {
          ...unevidenced[0]!,
          evidence: {
            permittedRoute: "",
            approvalReference: "oauth-app-123",
            checkedAt: "2026-02-27",
          },
        },
      ];
      expect(planAccessView(partial).state).not.toBe("supported");
    });

    it("reports supported once a permitted route carries evidence", () => {
      const evidenced: PlanAccessRoute[] = [
        {
          route: "linked-billing",
          state: "supported",
          reason: "app-registered",
          credential: "console-api-key",
          evidence: {
            permittedRoute:
              "https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections",
            approvalReference: "oauth-app-live-2026-11",
            checkedAt: "2026-11-18",
          },
        },
      ];
      const view = planAccessView(evidenced);
      expect(view.state).toBe("supported");
      // The evidence travels with the state so the panel can show it.
      expect(view.routes[0]!.evidence?.approvalReference).toBe("oauth-app-live-2026-11");
    });
  });

  describe("reading through the registry", () => {
    it("includes plan availability in the settings view for admitted members", async () => {
      for (const principal of [administrator, shopper]) {
        const read = await registry.read(principal);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.value.planAccess.state).toBe("approval-required");
        expect(read.value.planAccess.routes.map((route) => route.route)).toEqual([
          "consumer-subscription",
          "linked-billing",
        ]);
      }
      // Reading availability never contacts a provider.
      expect(probe.calls).toEqual([]);
    });

    it("refuses availability to anonymous callers and non-members", async () => {
      expect(await registry.read(anonymous)).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
      expect(await registry.read(stranger)).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
    });

    it("keeps API-key mode working while plan access is unavailable", async () => {
      const saved = await registry.saveInstallation(administrator, {
        defaultModel: anthropicTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "sk-ant-api-key-for-plan-test",
      });
      expect(saved.ok).toBe(true);

      const resolved = await registry.resolve(administrator);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value).toMatchObject({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        apiKey: "sk-ant-api-key-for-plan-test",
      });

      const read = await registry.read(administrator);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // Both facts are true at once: the key works, the plan does not.
      expect(read.value.effective).toMatchObject({
        source: "installation",
        defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      });
      expect(read.value.planAccess.state).toBe("approval-required");
      expect(JSON.stringify(read.value)).not.toContain("sk-ant-api-key-for-plan-test");
    });
  });
});
