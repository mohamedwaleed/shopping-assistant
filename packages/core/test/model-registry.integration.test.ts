// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import { createDb, DEFAULT_TEST_DATABASE_URL } from "@shopping/db";
import {
  createModelRegistry,
  createSecretCipher,
  DEFAULT_DIAGNOSTIC_BOUNDS,
  diagnosticBounds,
  type CapabilityReport,
  type ModelRegistry,
  type ModelProbeRequest,
  type ModelTarget,
  type Principal,
} from "../src/index";

// Core is the primary seam for model configuration: installation defaults and
// workspace overrides resolve through real PostgreSQL, secrets stay encrypted
// and masked, and diagnostic bounds are enforced here rather than by callers.
const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? DEFAULT_TEST_DATABASE_URL;
const INSTALLATION_SECRET = "installation-secret-0123456789abcdef";

const ADMIN = "admin-user";
const ADMIN_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SHOPPER = "shopper-user";
const SHOPPER_WORKSPACE = "22222222-2222-4222-8222-222222222222";

const administrator: Principal = {
  kind: "administrator",
  userId: ADMIN,
  workspaceId: ADMIN_WORKSPACE,
  sessionId: "model-test-admin-session",
};
const shopper: Principal = {
  kind: "workspace",
  userId: SHOPPER,
  workspaceId: SHOPPER_WORKSPACE,
  sessionId: "model-test-shopper-session",
};

async function seedUsers(db: Knex): Promise<void> {
  await db("user").insert([
    { id: ADMIN, name: "Ada Admin", email: "ada@example.nl" },
    { id: SHOPPER, name: "Sam Shopper", email: "sam@example.nl" },
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

/** Records every capability test the registry ran instead of calling a model. */
function fakeProbe() {
  const probed: ModelTarget[] = [];
  const reports: CapabilityReport[] = [];
  return {
    probed,
    reports,
    respondWith(report: CapabilityReport) {
      reports.push(report);
    },
    probe: async ({ target, bounds }: ModelProbeRequest) => {
      probed.push(target);
      return (
        reports.shift() ?? {
          provider: target.provider,
          modelId: target.modelId,
          testedAt: "2026-11-18T10:00:00.000Z",
          bounds,
          capabilities: { text: "supported", tools: "supported", structuredOutput: "supported", streaming: "supported" },
        }
      );
    },
  };
}

const compatibleTarget = {
  provider: "compatible" as const,
  modelId: "fixture-model-complete",
  endpoint: "http://127.0.0.1:9/v1",
};

describe("model registry through the core", () => {
  let db: Knex;
  let registry: ModelRegistry;
  let probe: ReturnType<typeof fakeProbe>;

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
    probe = fakeProbe();
    registry = createModelRegistry({
      db,
      cipher: createSecretCipher({ key: INSTALLATION_SECRET }),
      probe: probe.probe,
      now: () => new Date("2026-11-18T10:00:00.000Z"),
    });
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe("installation defaults", () => {
    it("reports an unconfigured installation instead of inventing a model", async () => {
      expect(await registry.read(administrator)).toMatchObject({
        ok: true,
        value: {
          installation: {
            defaultModel: null,
            extractionModel: null,
            credential: null,
          },
          workspace: null,
          effective: null,
        },
      });

      // No hidden fallback: resolving without a configured default fails loudly.
      expect(await registry.resolve(administrator)).toEqual({
        ok: false,
        error: { kind: "model-not-configured", role: "default" },
      });
    });

    it("stores the installation default for administrators only", async () => {
      expect(
        await registry.saveInstallation(shopper, {
          defaultModel: compatibleTarget,
          usageSource: "installation",
          extractionOverride: null,
          apiKey: null,
        }),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "installation.manage" } });

      const saved = await registry.saveInstallation(administrator, {
        defaultModel: compatibleTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "sk-installation-local-key",
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expect(saved.value.defaultModel).toEqual(compatibleTarget);
      expect(saved.value.usageSource).toBe("installation");
      expect(saved.value.credential).toEqual({
        source: "installation",
        masked: "sk-…key",
      });

      // Stored credentials are ciphertext at rest, never plaintext.
      const stored = await db("installation_model_credentials").first();
      expect(stored.ciphertext).not.toContain("sk-installation");
      expect(stored.ciphertext).not.toContain("openai-compatible");
      expect(stored.encryption).toBe("aes-256-gcm");
      expect(stored.masked_hint).toBe("sk-…key");

      // A workspace member sees the installation default, never its secret.
      const read = await registry.read(shopper);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.installation.defaultModel).toEqual(compatibleTarget);
      expect(read.value.installation.credential).toEqual({
        source: "installation",
        masked: "sk-…key",
      });
      expect(JSON.stringify(read.value)).not.toContain("sk-installation");
      expect(JSON.stringify(read.value)).not.toContain("ciphertext");
    });

    it("exposes model, usage-source and extraction overrides", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
        usageSource: "installation",
        extractionOverride: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        apiKey: "sk-installation-openai-key",
      });

      const read = await registry.read(administrator);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.installation.usageSource).toBe("installation");
      expect(read.value.installation.extractionModel).toEqual({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      });

      const resolved = await registry.resolve(administrator, "extraction");
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value).toMatchObject({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        source: "installation",
        usageSource: "installation",
        apiKey: "sk-installation-openai-key",
      });

      // Without an extraction override the default model serves extraction.
      await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "sk-installation-openai-key",
      });
      const fallbackRole = await registry.resolve(administrator, "extraction");
      expect(fallbackRole.ok).toBe(true);
      if (!fallbackRole.ok) return;
      expect(fallbackRole.value.modelId).toBe("gpt-5-mini");
    });

    it("keeps a stored key when a later save omits it and removes it on request", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "sk-installation-openai-key",
      });
      const kept = await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5.1-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: null,
      });
      expect(kept.ok).toBe(true);
      const resolved = await registry.resolve(administrator);
      expect(resolved).toMatchObject({
        ok: true,
        value: { modelId: "gpt-5.1-mini", apiKey: "sk-installation-openai-key" },
      });

      await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5.1-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: null,
        clearCredential: true,
      });
      expect(await registry.resolve(administrator)).toEqual({
        ok: false,
        error: { kind: "model-credential-missing", provider: "openai", source: "installation" },
      });
    });
  });

  describe("workspace overrides", () => {
    beforeEach(async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "sk-installation-openai-key",
      });
    });

    it("lets a workspace override the model with its own key without touching the installation", async () => {
      const saved = await registry.saveWorkspace(shopper, {
        defaultModel: compatibleTarget,
        usageSource: "workspace",
        extractionOverride: null,
        apiKey: "fixture-workspace-local-key",
      });
      expect(saved.ok).toBe(true);

      const shopperResolved = await registry.resolve(shopper);
      expect(shopperResolved).toMatchObject({
        ok: true,
        value: {
          provider: "compatible",
          modelId: "fixture-model-complete",
          source: "workspace",
          usageSource: "workspace",
          apiKey: "fixture-workspace-local-key",
        },
      });

      // The administrator's workspace is untouched: isolation, not sharing.
      const adminResolved = await registry.resolve(administrator);
      expect(adminResolved).toMatchObject({
        ok: true,
        value: { provider: "openai", modelId: "gpt-5-mini", source: "installation" },
      });

      const read = await registry.read(shopper);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.workspace?.defaultModel).toEqual(compatibleTarget);
      expect(JSON.stringify(read.value)).not.toContain("fixture-workspace-local-key");
      expect(JSON.stringify(read.value)).not.toContain("sk-installation-openai-key");
    });

    it("never admits a principal naming another workspace", async () => {
      const impostor: Principal = {
        kind: "workspace",
        userId: SHOPPER,
        workspaceId: ADMIN_WORKSPACE,
        sessionId: "model-test-impostor-session",
      };
      expect(
        await registry.saveWorkspace(impostor, {
          defaultModel: compatibleTarget,
          usageSource: "workspace",
          extractionOverride: null,
          apiKey: null,
        }),
      ).toEqual({ ok: false, error: { kind: "forbidden", capability: "workspace.read" } });
      expect(await registry.read(impostor)).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "workspace.read" },
      });
    });

    it("uses the installation key only when the workspace explicitly selects the installation source", async () => {
      const saved = await registry.saveWorkspace(shopper, {
        defaultModel: { provider: "openai", modelId: "gpt-5.1-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: null,
      });
      expect(saved.ok).toBe(true);
      expect(await registry.resolve(shopper)).toMatchObject({
        ok: true,
        value: {
          modelId: "gpt-5.1-mini",
          source: "workspace",
          usageSource: "installation",
          apiKey: "sk-installation-openai-key",
        },
      });
    });

    it("fails loudly when the chosen usage source has no credential", async () => {
      await registry.saveWorkspace(shopper, {
        defaultModel: compatibleTarget,
        usageSource: "workspace",
        extractionOverride: null,
        apiKey: null,
      });
      expect(await registry.resolve(shopper)).toEqual({
        ok: false,
        error: {
          kind: "model-credential-missing",
          provider: "compatible",
          source: "workspace",
        },
      });
    });
  });

  describe("credential ownership", () => {
    it("refuses to reuse a stored key for a different provider", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: { provider: "openai", modelId: "gpt-5-mini" },
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "sk-installation-openai-key",
      });
      expect(
        await registry.saveInstallation(administrator, {
          defaultModel: compatibleTarget,
          usageSource: "installation",
          extractionOverride: null,
          apiKey: null,
        }),
      ).toEqual({
        ok: false,
        error: {
          kind: "invalid-input",
          field: "apiKey",
          message: "a stored openai key cannot be reused for compatible; remove it or supply a new key",
        },
      });
      expect(await registry.resolve(administrator)).toMatchObject({
        ok: true,
        value: { provider: "openai", apiKey: "sk-installation-openai-key" },
      });
    });
  });

  describe("capability test", () => {
    it("enforces explicit call and token bounds", () => {
      expect(DEFAULT_DIAGNOSTIC_BOUNDS).toEqual({ maxCalls: 4, maxOutputTokens: 64 });
      expect(diagnosticBounds({ maxCalls: 0, maxOutputTokens: 64 })).toBeNull();
      expect(diagnosticBounds({ maxCalls: 2, maxOutputTokens: 0 })).toBeNull();
      expect(diagnosticBounds({ maxCalls: 99, maxOutputTokens: 64 })).toBeNull();
      expect(diagnosticBounds({ maxCalls: 2, maxOutputTokens: 10_000 })).toBeNull();
      expect(diagnosticBounds({ maxCalls: 2, maxOutputTokens: 32 })).toEqual({
        maxCalls: 2,
        maxOutputTokens: 32,
      });
      expect(diagnosticBounds(undefined)).toEqual(DEFAULT_DIAGNOSTIC_BOUNDS);
    });

    it("runs a bounded capability test for administrators and records the result", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: compatibleTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "fixture-local-key",
      });
      probe.respondWith({
        provider: "compatible",
        modelId: compatibleTarget.modelId,
        endpoint: compatibleTarget.endpoint,
        testedAt: "2026-11-18T10:00:00.000Z",
        bounds: { maxCalls: 3, maxOutputTokens: 32 },
        capabilities: { text: "supported", tools: "supported", structuredOutput: "unsupported", streaming: "supported" },
      });

      const result = await registry.testConnection(administrator, {
        bounds: { maxCalls: 3, maxOutputTokens: 32 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.capabilities.structuredOutput).toBe("unsupported");
      expect(result.value.bounds).toEqual({ maxCalls: 3, maxOutputTokens: 32 });
      expect(probe.probed).toEqual([
        {
          provider: "compatible",
          modelId: compatibleTarget.modelId,
          endpoint: compatibleTarget.endpoint,
        },
      ]);

      // The recorded result is readable by the workspace and stays secret-free.
      const read = await registry.read(shopper);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.capability?.capabilities.structuredOutput).toBe("unsupported");
      expect(JSON.stringify(read.value)).not.toContain("fixture-local-key");
    });

    it("applies the default bounds when the caller supplies none", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: compatibleTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "fixture-local-key",
      });
      await registry.testConnection(administrator, {});
      const read = await registry.read(administrator);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.capability?.bounds).toEqual(DEFAULT_DIAGNOSTIC_BOUNDS);
    });

    it("rejects out-of-bounds diagnostics and non-administrators", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: compatibleTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "fixture-local-key",
      });
      expect(
        await registry.testConnection(administrator, {
          bounds: { maxCalls: 50, maxOutputTokens: 32 },
        }),
      ).toEqual({
        ok: false,
        error: { kind: "invalid-input", field: "maxCalls", message: "maxCalls must be between 1 and 8" },
      });
      expect(await registry.testConnection(shopper, {})).toEqual({
        ok: false,
        error: { kind: "forbidden", capability: "installation.manage" },
      });
      expect(probe.probed).toEqual([]);
    });

    it("records a failed diagnostic without leaving a stale success behind", async () => {
      await registry.saveInstallation(administrator, {
        defaultModel: compatibleTarget,
        usageSource: "installation",
        extractionOverride: null,
        apiKey: "fixture-local-key",
      });
      probe.respondWith({
        provider: "compatible",
        modelId: compatibleTarget.modelId,
        endpoint: compatibleTarget.endpoint,
        testedAt: "2026-11-18T10:00:00.000Z",
        bounds: DEFAULT_DIAGNOSTIC_BOUNDS,
        capabilities: { text: "supported", tools: "unsupported", structuredOutput: "unsupported", streaming: "unsupported" },
        error: { kind: "provider-unavailable", message: "fixture rejects this credential" },
      });
      await registry.testConnection(administrator, {});
      const read = await registry.read(administrator);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.capability).toMatchObject({
        capabilities: { tools: "unsupported" },
        error: { kind: "provider-unavailable" },
      });
    });
  });
});
