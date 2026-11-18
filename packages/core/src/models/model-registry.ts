// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Knex } from "knex";
import { err, ok, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";
import { maskSecret, type SecretCipher } from "./secret-cipher";
import {
  DEFAULT_DIAGNOSTIC_BOUNDS,
  MAX_DIAGNOSTIC_CALLS,
  MAX_DIAGNOSTIC_OUTPUT_TOKENS,
  MODEL_PROVIDERS,
  type CapabilityReport,
  type DiagnosticBounds,
  type ModelConfigurationView,
  type ModelConfigurationViewResult,
  type ModelCredentialSummary,
  type ModelProbe,
  type ModelProvider,
  type ModelRole,
  type ModelTarget,
  type ResolvedModel,
  type SaveModelConfiguration,
  type UsageSource,
} from "./types";

export interface ModelRegistryDependencies {
  db: Knex;
  cipher: SecretCipher;
  /** AI SDK adapter; core decides the bounds and records the outcome. */
  probe: ModelProbe;
  now?: () => Date;
}

export interface ModelRegistry {
  read(principal: Principal): Promise<Result<ModelConfigurationViewResult>>;
  saveInstallation(
    principal: Principal,
    input: SaveModelConfiguration,
  ): Promise<Result<ModelConfigurationView>>;
  saveWorkspace(
    principal: Principal,
    input: SaveModelConfiguration,
  ): Promise<Result<ModelConfigurationView>>;
  /**
   * The model that serves this workspace for a role. There is no fallback: an
   * unconfigured role or a missing credential is a typed error, never another
   * provider, model or account.
   */
  resolve(principal: Principal, role?: ModelRole): Promise<Result<ResolvedModel>>;
  testConnection(
    principal: Principal,
    input: { bounds?: Partial<DiagnosticBounds> },
  ): Promise<Result<CapabilityReport>>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

interface SettingsRow {
  default_model: string | null;
  extraction_model: string | null;
  usage_source: UsageSource | null;
  capability_tested_at: Date | null;
  capability_report: CapabilityReport | null;
}

interface CredentialRow {
  provider: ModelProvider;
  ciphertext: string;
  masked_hint: string;
}

interface StoredSettings {
  defaultModel: ModelTarget | null;
  extractionModel: ModelTarget | null;
  usageSource: UsageSource | null;
  capability: CapabilityReport | null;
}

/**
 * Validate explicit diagnostic bounds. Anything outside the ceilings is a
 * caller error, not silently clamped: a diagnostic is a paid, visible action.
 */
export function diagnosticBounds(
  requested: Partial<DiagnosticBounds> | undefined,
): DiagnosticBounds | null {
  const maxCalls = requested?.maxCalls ?? DEFAULT_DIAGNOSTIC_BOUNDS.maxCalls;
  const maxOutputTokens =
    requested?.maxOutputTokens ?? DEFAULT_DIAGNOSTIC_BOUNDS.maxOutputTokens;
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > MAX_DIAGNOSTIC_CALLS) return null;
  if (
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > MAX_DIAGNOSTIC_OUTPUT_TOKENS
  ) {
    return null;
  }
  return { maxCalls, maxOutputTokens };
}

function parseTarget(raw: string | null): ModelTarget | null {
  if (!raw) return null;
  try {
    return validateTarget(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function validateTarget(value: unknown): ModelTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  if (typeof provider !== "string" || !MODEL_PROVIDERS.includes(provider as ModelProvider)) {
    return null;
  }
  const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
  if (!MODEL_ID_PATTERN.test(modelId)) return null;
  const endpoint = typeof record.endpoint === "string" ? record.endpoint.trim() : undefined;
  if (provider === "compatible") {
    if (!endpoint || !isHttpUrl(endpoint)) return null;
    return { provider: provider as ModelProvider, modelId, endpoint };
  }
  return endpoint
    ? { provider: provider as ModelProvider, modelId, endpoint }
    : { provider: provider as ModelProvider, modelId };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The provider a new key belongs to: the default model, else the extraction model. */
function credentialProvider(value: {
  defaultModel: ModelTarget | null;
  extractionModel: ModelTarget | null;
}): ModelProvider {
  return (value.defaultModel ?? value.extractionModel)!.provider;
}

/**
 * An existing key belongs to one provider. Silently reusing it for another
 * would send a credential to an endpoint it was never issued for, so the save
 * is refused instead.
 */
function reuseError(
  stored: CredentialRow | null,
  value: { apiKey: string | null; clearCredential: boolean; defaultModel: ModelTarget | null; extractionModel: ModelTarget | null },
): Result<never> | null {
  if (!stored || value.apiKey !== null || value.clearCredential) return null;
  const provider = credentialProvider(value);
  if (stored.provider === provider) return null;
  return err({
    kind: "invalid-input",
    field: "apiKey",
    message: `a stored ${stored.provider} key cannot be reused for ${provider}; remove it or supply a new key`,
  });
}

function viewOf(
  settings: StoredSettings,
  credential: ModelCredentialSummary | null,
): ModelConfigurationView {
  return {
    defaultModel: settings.defaultModel,
    extractionModel: settings.extractionModel,
    usageSource: settings.usageSource,
    credential,
  };
}

export function createModelRegistry(deps: ModelRegistryDependencies): ModelRegistry {
  const { db, cipher, probe } = deps;
  const now = deps.now ?? (() => new Date());

  function membershipWorkspace(principal: Principal): Result<string> {
    if (principal.kind === "anonymous" || !isAuthorized(principal, "workspace.read")) {
      return err({ kind: "forbidden", capability: "workspace.read" });
    }
    if (!UUID_PATTERN.test(principal.workspaceId)) {
      return err({
        kind: "invalid-input",
        field: "workspaceId",
        message: "workspaceId must be a UUID",
      });
    }
    return ok(principal.workspaceId);
  }

  /** Workspace configuration is only ever read for an admitted membership. */
  async function admittedWorkspace(principal: Principal): Promise<Result<string>> {
    const workspaceId = membershipWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    if (principal.kind === "anonymous") return err({ kind: "forbidden", capability: "workspace.read" });
    const membership = await db("workspace_memberships")
      .where({ workspace_id: workspaceId.value, user_id: principal.userId })
      .first();
    if (!membership) return err({ kind: "forbidden", capability: "workspace.read" });
    return workspaceId;
  }

  async function readSettings(): Promise<StoredSettings> {
    const row = (await db("installation_model_settings").where({ id: 1 }).first()) as
      | SettingsRow
      | undefined;
    // The installation row is created by the migration; an empty table means a
    // schema reset, and configuration is simply absent rather than invented.
    if (!row) {
      return { defaultModel: null, extractionModel: null, usageSource: null, capability: null };
    }
    return {
      defaultModel: parseTarget(row.default_model),
      extractionModel: parseTarget(row.extraction_model),
      usageSource: row.usage_source,
      capability: row.capability_report,
    };
  }

  async function readWorkspaceSettings(workspaceId: string): Promise<StoredSettings | null> {
    const row = (await db("workspace_model_settings")
      .where({ workspace_id: workspaceId })
      .first()) as SettingsRow | undefined;
    if (!row) return null;
    return {
      defaultModel: parseTarget(row.default_model),
      extractionModel: parseTarget(row.extraction_model),
      usageSource: row.usage_source,
      capability: row.capability_report,
    };
  }

  async function readCredential(
    source: "installation" | "workspace",
    workspaceId?: string,
  ): Promise<(CredentialRow & { apiKey: string }) | null> {
    const row =
      source === "installation"
        ? ((await db("installation_model_credentials").where({ id: 1 }).first()) as
            | CredentialRow
            | undefined)
        : ((await db("workspace_model_credentials")
            .where({ workspace_id: workspaceId })
            .first()) as CredentialRow | undefined);
    if (!row) return null;
    return { ...row, apiKey: cipher.decrypt(row.ciphertext) };
  }

  function summaryOf(
    row: CredentialRow | null,
    source: "installation" | "workspace",
  ): ModelCredentialSummary | null {
    return row ? { source, masked: row.masked_hint } : null;
  }

  function validateSave(input: SaveModelConfiguration): Result<{
    defaultModel: ModelTarget | null;
    extractionModel: ModelTarget | null;
    usageSource: UsageSource;
    apiKey: string | null;
    clearCredential: boolean;
  }> {
    if (input.usageSource !== "installation" && input.usageSource !== "workspace") {
      return err({
        kind: "invalid-input",
        field: "usageSource",
        message: "usageSource must be installation or workspace",
      });
    }
    const defaultModel =
      input.defaultModel === null ? null : validateTarget(input.defaultModel);
    if (input.defaultModel !== null && !defaultModel) {
      return err({
        kind: "invalid-input",
        field: "defaultModel",
        message: "defaultModel must name a supported provider, model id and endpoint",
      });
    }
    const extractionModel =
      input.extractionOverride === null ? null : validateTarget(input.extractionOverride);
    if (input.extractionOverride !== null && !extractionModel) {
      return err({
        kind: "invalid-input",
        field: "extractionModel",
        message: "extractionModel must name a supported provider, model id and endpoint",
      });
    }
    if (input.apiKey !== null && !input.apiKey.trim()) {
      return err({
        kind: "invalid-input",
        field: "apiKey",
        message: "apiKey must not be blank",
      });
    }
    return ok({
      defaultModel,
      extractionModel,
      usageSource: input.usageSource,
      apiKey: input.apiKey === null ? null : input.apiKey.trim(),
      clearCredential: input.clearCredential ?? false,
    });
  }

  /**
   * Store the key only when one was supplied; a save never silently drops it.
   * A key is always stored against a provider, so the credential records which
   * one it belongs to rather than guessing later, and a stored key is never
   * carried over to a different provider.
   */
  async function storeCredential(
    scope: { kind: "installation" } | { kind: "workspace"; workspaceId: string },
    provider: ModelProvider,
    input: { apiKey: string | null; clearCredential: boolean },
  ): Promise<void> {
    const table =
      scope.kind === "installation" ? "installation_model_credentials" : "workspace_model_credentials";
    const where = scope.kind === "installation" ? { id: 1 } : { workspace_id: scope.workspaceId };
    if (input.clearCredential) {
      await db(table).where(where).delete();
      return;
    }
    if (input.apiKey === null) return;
    const row = {
      provider,
      ciphertext: cipher.encrypt(input.apiKey),
      encryption: cipher.encryption,
      masked_hint: maskSecret(input.apiKey),
      updated_at: now(),
    };
    if (scope.kind === "installation") {
      await db(table)
        .insert({ id: 1, ...row })
        .onConflict("id")
        .merge();
      return;
    }
    await db(table)
      .insert({ workspace_id: scope.workspaceId, ...row })
      .onConflict("workspace_id")
      .merge();
  }

  /**
   * A model change invalidates an earlier capability result: the old report
   * described a different endpoint or model and must not be shown as current.
   */
  function clearedCapability(previous: StoredSettings, next: StoredSettings) {
    const changed =
      JSON.stringify(previous.defaultModel) !== JSON.stringify(next.defaultModel) ||
      JSON.stringify(previous.extractionModel) !== JSON.stringify(next.extractionModel);
    return changed
      ? { capability_report: null, capability_tested_at: null }
      : {};
  }

  async function saveInstallation(
    principal: Principal,
    input: SaveModelConfiguration,
  ): Promise<Result<ModelConfigurationView>> {
    if (!isAuthorized(principal, "installation.manage")) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }
    const valid = validateSave(input);
    if (!valid.ok) return valid;
    const value = valid.value;
    const stored = await readCredential("installation");
    const reuse = reuseError(stored, value);
    if (reuse) return reuse;

    const previous = await readSettings();
    const next: StoredSettings = {
      defaultModel: value.defaultModel,
      extractionModel: value.extractionModel,
      usageSource: value.usageSource,
      capability: previous.capability,
    };
    // The migration seeds the singleton row; recreate it if a schema reset
    // removed it so configuration is never silently discarded.
    await db("installation_model_settings")
      .insert({ id: 1, updated_at: now() })
      .onConflict("id")
      .ignore();
    await db("installation_model_settings")
      .where({ id: 1 })
      .update({
        default_model: value.defaultModel ? JSON.stringify(value.defaultModel) : null,
        extraction_model: value.extractionModel ? JSON.stringify(value.extractionModel) : null,
        usage_source: value.usageSource,
        updated_at: now(),
        ...clearedCapability(previous, next),
      });
    if (value.apiKey !== null) {
      await storeCredential({ kind: "installation" }, credentialProvider(value), value);
    } else if (value.clearCredential) {
      await storeCredential({ kind: "installation" }, credentialProvider(value), value);
    }

    const credential = await readCredential("installation");
    return ok(viewOf(next, summaryOf(credential, "installation")));
  }

  async function saveWorkspace(
    principal: Principal,
    input: SaveModelConfiguration,
  ): Promise<Result<ModelConfigurationView>> {
    const workspaceId = await admittedWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    const valid = validateSave(input);
    if (!valid.ok) return valid;
    const value = valid.value;
    const reuse = reuseError(await readCredential("workspace", workspaceId.value), value);
    if (reuse) return reuse;

    const previous = await readWorkspaceSettings(workspaceId.value);
    const next: StoredSettings = {
      defaultModel: value.defaultModel,
      extractionModel: value.extractionModel,
      usageSource: value.usageSource,
      capability: previous?.capability ?? null,
    };
    const row = {
      default_model: value.defaultModel ? JSON.stringify(value.defaultModel) : null,
      extraction_model: value.extractionModel ? JSON.stringify(value.extractionModel) : null,
      usage_source: value.usageSource,
      updated_at: now(),
      ...(previous ? clearedCapability(previous, next) : { capability_report: null, capability_tested_at: null }),
    };
    await db("workspace_model_settings")
      .insert({ workspace_id: workspaceId.value, ...row })
      .onConflict("workspace_id")
      .merge();
    if (value.apiKey !== null) {
      await storeCredential({ kind: "workspace", workspaceId: workspaceId.value }, credentialProvider(value), value);
    } else if (value.clearCredential) {
      await storeCredential({ kind: "workspace", workspaceId: workspaceId.value }, credentialProvider(value), value);
    }

    const credential = await readCredential("workspace", workspaceId.value);
    return ok(viewOf(next, summaryOf(credential, "workspace")));
  }

  async function read(principal: Principal): Promise<Result<ModelConfigurationViewResult>> {
    const workspaceId = await admittedWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;

    const installation = await readSettings();
    const installationCredential = await readCredential("installation");
    const workspace = await readWorkspaceSettings(workspaceId.value);
    const workspaceCredential = await readCredential("workspace", workspaceId.value);

    const installationView = viewOf(
      installation,
      summaryOf(installationCredential, "installation"),
    );
    const workspaceView = workspace
      ? viewOf(workspace, summaryOf(workspaceCredential, "workspace"))
      : null;
    const effectiveSettings = workspace ?? installation;
    const effectiveCredential =
      effectiveSettings.usageSource === "workspace" ? workspaceCredential : installationCredential;
    const effective = effectiveSettings.defaultModel
      ? {
          ...viewOf(
            effectiveSettings,
            summaryOf(
              effectiveCredential,
              effectiveSettings.usageSource === "workspace" ? "workspace" : "installation",
            ),
          ),
          source: workspace ? ("workspace" as const) : ("installation" as const),
        }
      : null;

    return ok({
      installation: installationView,
      workspace: workspaceView,
      effective,
      capability: (workspace ?? installation).capability,
      diagnostics: {
        bounds: DEFAULT_DIAGNOSTIC_BOUNDS,
        limits: {
          maxCalls: MAX_DIAGNOSTIC_CALLS,
          maxOutputTokens: MAX_DIAGNOSTIC_OUTPUT_TOKENS,
        },
      },
    });
  }

  async function resolve(
    principal: Principal,
    role: ModelRole = "default",
  ): Promise<Result<ResolvedModel>> {
    const workspaceId = await admittedWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;

    const workspace = await readWorkspaceSettings(workspaceId.value);
    const installation = await readSettings();
    const settings = workspace ?? installation;
    const source: "installation" | "workspace" = workspace ? "workspace" : "installation";

    const target =
      role === "extraction"
        ? (settings.extractionModel ?? settings.defaultModel)
        : settings.defaultModel;
    if (!target) return err({ kind: "model-not-configured", role });

    const usageSource: UsageSource = settings.usageSource ?? "installation";
    const credential = await readCredential(
      usageSource,
      usageSource === "workspace" ? workspaceId.value : undefined,
    );
    if (!credential) {
      return err({ kind: "model-credential-missing", provider: target.provider, source: usageSource });
    }

    return ok({
      ...target,
      role,
      source,
      usageSource,
      apiKey: credential.apiKey,
    });
  }

  async function testConnection(
    principal: Principal,
    input: { bounds?: Partial<DiagnosticBounds> },
  ): Promise<Result<CapabilityReport>> {
    if (!isAuthorized(principal, "installation.manage")) {
      return err({ kind: "forbidden", capability: "installation.manage" });
    }
    const bounds = diagnosticBounds(input.bounds);
    if (!bounds) {
      const maxCalls = input.bounds?.maxCalls;
      const maxOutputTokens = input.bounds?.maxOutputTokens;
      if (maxCalls !== undefined) {
        return err({
          kind: "invalid-input",
          field: "maxCalls",
          message: `maxCalls must be between 1 and ${MAX_DIAGNOSTIC_CALLS}`,
        });
      }
      if (maxOutputTokens !== undefined) {
        return err({
          kind: "invalid-input",
          field: "maxOutputTokens",
          message: `maxOutputTokens must be between 1 and ${MAX_DIAGNOSTIC_OUTPUT_TOKENS}`,
        });
      }
      return err({
        kind: "invalid-input",
        field: "bounds",
        message: "diagnostic bounds must be whole numbers",
      });
    }

    const target = await resolve(principal);
    if (!target.ok) return target;

    const report = await probe({
      target: {
        provider: target.value.provider,
        modelId: target.value.modelId,
        ...(target.value.endpoint ? { endpoint: target.value.endpoint } : {}),
      },
      provider: target.value.provider,
      apiKey: target.value.apiKey,
      bounds,
    });

    // The recorded report is scoped to whoever ran it: a workspace diagnostic
    // never overwrites the installation's result.
    const workspaceId = await admittedWorkspace(principal);
    if (!workspaceId.ok) return workspaceId;
    const workspace = await readWorkspaceSettings(workspaceId.value);
    const table = workspace ? "workspace_model_settings" : "installation_model_settings";
    const where = workspace ? { workspace_id: workspaceId.value } : { id: 1 };
    await db(table)
      .where(where)
      .update({
        capability_tested_at: new Date(report.testedAt),
        capability_report: report,
        updated_at: now(),
      });

    return ok(report);
  }

  return { read, saveInstallation, saveWorkspace, resolve, testConnection };
}
