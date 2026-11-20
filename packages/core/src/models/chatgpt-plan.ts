// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { err, ok, type CoreError, type Result } from "../errors";
import { isAuthorized, type Principal } from "../principal";
import { maskSecret, type SecretCipher } from "./secret-cipher";
import {
  CHATGPT_PLAN_ENTITLEMENT,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_SCOPES,
  CHATGPT_PLAN_SCOPE,
  type ChatGPTPlanAccount,
  type ChatGPTPlanConsentAttempt,
  type ChatGPTPlanEligibility,
  type ChatGPTPlanExerciseFn,
  type ChatGPTPlanExerciseResult,
  type ChatGPTPlanModel,
  type ChatGPTPlanOutcome,
  type ChatGPTPlanPauseReason,
  type ChatGPTPlanRefreshResult,
  type ChatGPTPlanState,
  type ChatGPTPlanStatus,
  type ChatGPTPlanTokenGrant,
  type ChatGPTPlanUsageSource,
  type ChatGPTPlanView,
  type ResolvedChatGPTPlanRequest,
} from "./chatgpt-plan-types";

/**
 * ChatGPT plan usage as a workspace-owned provider connection (docs/adr/0013).
 *
 * The connection is deliberately separate from application sign-in: it stores
 * the provider account's validated subject and tokens against the workspace,
 * never against a `user` or `account` row, so authorizing a provider can never
 * create, link or merge an application identity. Consent, refresh, disconnect
 * and account-specific model selection are authorized here from stored
 * workspace membership; a request body or query string selects nothing.
 */
export interface ChatGPTPlanConnections {
  /** Start consent: fresh state, nonce and PKCE for one attempt. */
  beginConsent(
    principal: Principal,
    input: { loginHint?: string | null },
  ): Promise<Result<ChatGPTPlanConsentAttempt>>;
  /** Exchange an authorization code for tokens and store them encrypted. */
  completeConsent(
    principal: Principal,
    grant: ChatGPTPlanTokenGrant | null,
    callback?: { error?: string },
  ): Promise<Result<ChatGPTPlanView>>;
  read(principal: Principal): Promise<Result<ChatGPTPlanView>>;
  /**
   * Choose one of the account's own models. The available list comes from the
   * provider's model endpoint for this account; an unlisted model is refused.
   */
  selectModel(
    principal: Principal,
    model: { slug: string; displayName?: string },
    available?: ChatGPTPlanModel[],
  ): Promise<Result<ChatGPTPlanModel>>;
  setUsageSource(
    principal: Principal,
    input: { usageSource: ChatGPTPlanUsageSource },
  ): Promise<Result<ChatGPTPlanView>>;
  /** Record a refreshed rotating pair, or end the grant on a terminal error. */
  recordRefresh(
    principal: Principal,
    result: ChatGPTPlanRefreshResult,
  ): Promise<Result<ChatGPTPlanView>>;
  /** Record an observed Responses outcome so the state stays truthful. */
  recordOutcome(
    principal: Principal,
    outcome: ChatGPTPlanOutcome,
  ): Promise<Result<ChatGPTPlanView>>;
  /** The plan request a shopping turn may make, or a typed refusal. */
  resolve(principal: Principal): Promise<Result<ResolvedChatGPTPlanRequest>>;
  /**
   * The stored grant a refresh may spend. Deliberately not gated on expiry or a
   * paused plan: refreshing is how an expired or paused connection recovers,
   * and the adapter never sees the refresh token.
   */
  resolveRefresh(
    principal: Principal,
  ): Promise<Result<{ refreshToken: string; clientId: string }>>;
  /** Exercise a shopping tool step through the account's own model. */
  exercisePlan(
    principal: Principal,
    input: {
      prompt: string;
      tools?: string[];
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    },
  ): Promise<Result<ChatGPTPlanExerciseResult & { modelId: string }>>;
  disconnect(principal: Principal): Promise<Result<ChatGPTPlanView>>;
}

export interface ChatGPTPlanDependencies {
  db: Knex;
  cipher: SecretCipher;
  /** The pinned AI SDK adapter; core never imports a provider SDK. */
  exercise: ChatGPTPlanExerciseFn;
  now?: () => Date;
  /** Agent host identity, generated once per installation and persisted. */
  hostId?: string;
  /** OAuth endpoint overrides, used only by fixtures. */
  authorizeUrl?: string;
  tokenUrl?: string;
  redirectUri?: string;
  agentName?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const DEFAULT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const DEFAULT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
export const DEFAULT_AGENT_NAME = "Shopping Assistant";
/** Official lifetime of a plan access token; used only when a grant omits it. */
export const CHATGPT_PLAN_ACCESS_TOKEN_SECONDS = 3600;
const RECENT_EVENTS = 5;

interface ConnectionRow {
  workspace_id: string;
  account_subject: string;
  account_email_hint: string | null;
  client_id: string;
  host_id: string;
  ciphertext: string;
  encryption: string;
  scopes: string;
  expires_at: Date;
  plan_enabled: boolean;
  status: ChatGPTPlanStatus;
  selected_model: string | null;
  selected_model_label: string | null;
  usage_source: ChatGPTPlanUsageSource;
  plan_state: "available" | "paused";
  plan_reason: ChatGPTPlanPauseReason | null;
  plan_message: string | null;
  last_checked_at: Date | null;
  disconnected_at: Date | null;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

function scopesOf(raw: string): string[] {
  return raw.split(" ").filter(Boolean);
}

/** The plan scope must be granted, not merely requested. */
export function planScopeGranted(scopes: string[]): boolean {
  return scopes.includes(CHATGPT_PLAN_SCOPE);
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Mask an email for display: `sam@example.nl` → `s…@example.nl`. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return maskSecret(email);
  return `${email.slice(0, 1)}…${email.slice(at)}`;
}

function stateFrom(row: ConnectionRow, now: Date): ChatGPTPlanState {
  if (row.plan_state === "paused" && row.plan_reason) {
    return {
      state: "paused",
      reason: row.plan_reason,
      message: row.plan_message,
      retryAfterSeconds: row.plan_reason === "usage-unavailable" ? 60 : null,
    };
  }
  // Expiry is observed, never assumed from a stored flag: a connection whose
  // access token has lapsed reads as paused until a refresh lands.
  if (row.status === "connected" && row.plan_enabled && isExpired(row, now)) {
    return { state: "paused", reason: "expired", message: null, retryAfterSeconds: null };
  }
  return { state: "available", reason: null, message: null, retryAfterSeconds: null };
}

function isExpired(row: ConnectionRow, now: Date): boolean {
  return new Date(row.expires_at).getTime() <= now.getTime();
}

function statusOf(row: ConnectionRow): ChatGPTPlanView["status"] {
  if (row.status === "disconnected") return "disconnected";
  return row.plan_enabled ? "connected" : "plan-disabled";
}

function eligibilityFrom(row: ConnectionRow | null, now: Date): ChatGPTPlanEligibility {
  if (!row || row.status === "disconnected") return "disconnected";
  if (!row.plan_enabled) return "not-enabled";
  if (row.plan_reason === "not-eligible") return "not-eligible";
  if (row.plan_reason === "usage-unavailable") return "unavailable";
  if (row.plan_reason === "usage-limit" || row.plan_reason === "unsupported-capability") {
    return "eligible";
  }
  if (isExpired(row, now)) return "expired";
  return "eligible";
}

const PAUSE_ERROR: Record<ChatGPTPlanPauseReason, CoreError> = {
  "usage-limit": { kind: "chatgpt-plan-usage-limit", reason: "usage-limit" },
  "not-eligible": { kind: "chatgpt-plan-usage-limit", reason: "not-eligible" },
  "usage-unavailable": { kind: "chatgpt-plan-usage-limit", reason: "usage-unavailable" },
  "unsupported-capability": { kind: "chatgpt-plan-usage-limit", reason: "unsupported-capability" },
  expired: { kind: "chatgpt-plan-expired" },
};

export function createChatGPTPlanConnections(
  deps: ChatGPTPlanDependencies,
): ChatGPTPlanConnections {
  const { db, cipher, exercise } = deps;
  const now = deps.now ?? (() => new Date());
  const authorizeUrl = deps.authorizeUrl ?? DEFAULT_AUTHORIZE_URL;
  const redirectUri = deps.redirectUri ?? DEFAULT_REDIRECT_URI;
  const agentName = deps.agentName ?? DEFAULT_AGENT_NAME;
  let hostId = deps.hostId;

  function hostIdentity(): string {
    // The host identity names where this installation runs, never a person:
    // an opaque urn:uuid value persisted for the installation's lifetime.
    hostId ??= `urn:uuid:${randomUUID()}`;
    return hostId;
  }

  async function admitted(principal: Principal): Promise<Result<string>> {
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
    const membership = await db("workspace_memberships")
      .where({ workspace_id: principal.workspaceId, user_id: principal.userId })
      .first();
    if (!membership) return err({ kind: "forbidden", capability: "workspace.read" });
    return ok(principal.workspaceId);
  }

  async function rowFor(workspaceId: string): Promise<ConnectionRow | null> {
    const row = (await db("chatgpt_plan_connections")
      .where({ workspace_id: workspaceId })
      .first()) as ConnectionRow | undefined;
    return row ?? null;
  }

  async function record(
    workspaceId: string,
    kind: string,
    reason: string | null = null,
    message: string | null = null,
  ): Promise<void> {
    await db("chatgpt_plan_usage_events").insert({
      workspace_id: workspaceId,
      kind,
      reason,
      message: message ? message.slice(0, 500) : null,
      observed_at: now(),
    });
  }

  /** The API-key configuration that exists, so billing is never a guess. */
  async function apiKeyView(workspaceId: string): Promise<ChatGPTPlanView["apiKey"]> {
    const workspace = (await db("workspace_model_settings")
      .where({ workspace_id: workspaceId })
      .first()) as { default_model: string | null; usage_source: string | null } | undefined;
    const installation = (await db("installation_model_settings")
      .where({ id: 1 })
      .first()) as { default_model: string | null; usage_source: string | null } | undefined;
    const raw = workspace?.default_model ?? installation?.default_model ?? null;
    if (!raw) return { configured: false, provider: null, modelId: null, source: null };
    try {
      const target = JSON.parse(raw) as { provider?: string; modelId?: string };
      if (typeof target.provider !== "string" || typeof target.modelId !== "string") {
        return { configured: false, provider: null, modelId: null, source: null };
      }
      const source = workspace?.default_model ? "workspace" : "installation";
      const usageSource = (workspace?.usage_source ?? installation?.usage_source) ?? "installation";
      const credentialTable =
        usageSource === "workspace"
          ? db("workspace_model_credentials").where({ workspace_id: workspaceId })
          : db("installation_model_credentials").where({ id: 1 });
      const credential = await credentialTable.first();
      return {
        configured: Boolean(credential),
        provider: target.provider as ChatGPTPlanView["apiKey"]["provider"],
        modelId: target.modelId,
        source,
      };
    } catch {
      return { configured: false, provider: null, modelId: null, source: null };
    }
  }

  async function view(workspaceId: string, row: ConnectionRow | null): Promise<ChatGPTPlanView> {
    const apiKey = await apiKeyView(workspaceId);
    const events = (await db("chatgpt_plan_usage_events")
      .where({ workspace_id: workspaceId })
      .orderBy("observed_at", "desc")
      .orderBy("id", "desc")
      .limit(RECENT_EVENTS)) as Array<{ kind: string; reason: string | null; observed_at: Date }>;
    const base = {
      usageSource: (row?.usage_source ?? "api-key") as ChatGPTPlanUsageSource,
      apiKey,
      entitlement: CHATGPT_PLAN_ENTITLEMENT,
      events: events.map((event) => ({
        kind: event.kind,
        reason: event.reason,
        observedAt: new Date(event.observed_at).toISOString(),
      })),
    };
    if (!row) {
      return {
        ...base,
        status: "disconnected",
        eligibility: "disconnected",
        account: null,
        selectedModel: null,
        models: [],
        plan: { state: "available", reason: null, message: null, retryAfterSeconds: null },
        expiresAt: null,
        scopes: [],
        lastCheckedAt: null,
      };
    }
    const account: ChatGPTPlanAccount = {
      subject: row.account_subject,
      emailHint: row.account_email_hint,
    };
    return {
      ...base,
      status: statusOf(row),
      eligibility: eligibilityFrom(row, now()),
      account,
      selectedModel: row.selected_model
        ? { modelId: row.selected_model, displayName: row.selected_model_label ?? row.selected_model }
        : null,
      models: [],
      plan: stateFrom(row, now()),
      expiresAt: new Date(row.expires_at).toISOString(),
      scopes: scopesOf(row.scopes),
      lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    };
  }

  async function requireConnection(workspaceId: string): Promise<Result<ConnectionRow>> {
    const row = await rowFor(workspaceId);
    if (!row) return err({ kind: "chatgpt-plan-not-connected" });
    return ok(row);
  }

  async function beginConsent(
    principal: Principal,
    input: { loginHint?: string | null },
  ): Promise<Result<ChatGPTPlanConsentAttempt>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;

    const state = randomToken();
    const codeVerifier = randomToken();
    const params = new URLSearchParams({
      client_id: "dynamic_agent_client",
      agent_name_hint: agentName,
      ext_agent_host_id: hostIdentity(),
      response_type: "code",
      redirect_uri: redirectUri,
      scope: CHATGPT_PLAN_SCOPES.join(" "),
      resource: CHATGPT_PLAN_RESOURCE,
      state,
      nonce: randomToken(),
      code_challenge_method: "S256",
      code_challenge: pkceChallenge(codeVerifier),
    });
    if (input.loginHint) params.set("login_hint", input.loginHint);

    return ok({
      authorizationUrl: `${authorizeUrl}?${params.toString()}`,
      state,
      codeChallenge: params.get("code_challenge")!,
      scope: [...CHATGPT_PLAN_SCOPES],
      hostId: hostIdentity(),
      codeVerifier,
      entitlement: CHATGPT_PLAN_ENTITLEMENT,
    });
  }

  async function completeConsent(
    principal: Principal,
    grant: ChatGPTPlanTokenGrant | null,
    callback: { error?: string } = {},
  ): Promise<Result<ChatGPTPlanView>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    if (callback.error === "access_denied") {
      return err({ kind: "chatgpt-plan-consent-declined" });
    }
    if (!grant) return err({ kind: "chatgpt-plan-consent-declined" });

    const planEnabled = planScopeGranted(grant.scopes);
    const ciphertext = cipher.encrypt(
      JSON.stringify({ accessToken: grant.accessToken, refreshToken: grant.refreshToken }),
    );
    // A new grant re-opens the connection: the shopper just authorized it, so
    // an earlier pause, expiry or disconnect no longer describes this grant.
    const row = {
      workspace_id: workspaceId.value,
      account_subject: grant.account.subject,
      account_email_hint: maskEmail(grant.account.email),
      client_id: grant.clientId,
      host_id: hostIdentity(),
      ciphertext,
      encryption: cipher.encryption,
      scopes: grant.scopes.join(" "),
      expires_at: grant.expiresAt,
      plan_enabled: planEnabled,
      status: "connected",
      selected_model: null,
      selected_model_label: null,
      usage_source: "chatgpt-plan",
      plan_state: "available",
      plan_reason: null,
      plan_message: null,
      last_checked_at: now(),
      disconnected_at: null,
      updated_at: now(),
    };
    await db("chatgpt_plan_connections")
      .insert(row)
      .onConflict("workspace_id")
      .merge();
    await record(workspaceId.value, "refreshed", null, planEnabled ? "consent granted" : "plan scope withheld");
    const stored = await requireConnection(workspaceId.value);
    if (!stored.ok) return stored;
    return ok(await view(workspaceId.value, stored.value));
  }

  async function read(principal: Principal): Promise<Result<ChatGPTPlanView>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    return ok(await view(workspaceId.value, await rowFor(workspaceId.value)));
  }

  async function selectModel(
    principal: Principal,
    model: { slug: string; displayName?: string },
    available?: ChatGPTPlanModel[],
  ): Promise<Result<ChatGPTPlanModel>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;
    if (connection.value.status !== "connected") {
      return err({ kind: "chatgpt-plan-disconnected" });
    }
    if (!connection.value.plan_enabled) return err({ kind: "chatgpt-plan-not-enabled" });

    const slug = typeof model.slug === "string" ? model.slug.trim() : "";
    if (!MODEL_ID_PATTERN.test(slug)) {
      return err({
        kind: "invalid-input",
        field: "modelId",
        message: "modelId must name a model the account lists",
      });
    }
    // Account-specific: only a model the account's own list offered is stored.
    if (available) {
      const listed = available.find((entry) => entry.modelId === slug);
      if (!listed) {
        return err({
          kind: "chatgpt-plan-model-unavailable",
          modelId: slug,
          available: available.map((entry) => entry.modelId),
        });
      }
    }
    const displayName = model.displayName?.trim() || slug;
    await db("chatgpt_plan_connections")
      .where({ workspace_id: workspaceId.value })
      .update({
        selected_model: slug,
        selected_model_label: displayName,
        usage_source: "chatgpt-plan",
        updated_at: now(),
      });
    return ok({ modelId: slug, displayName });
  }

  async function setUsageSource(
    principal: Principal,
    input: { usageSource: ChatGPTPlanUsageSource },
  ): Promise<Result<ChatGPTPlanView>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    if (input.usageSource !== "chatgpt-plan" && input.usageSource !== "api-key") {
      return err({
        kind: "invalid-input",
        field: "usageSource",
        message: "usageSource must be chatgpt-plan or api-key",
      });
    }
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;
    if (input.usageSource === "chatgpt-plan") {
      if (connection.value.status !== "connected") {
        return err({ kind: "chatgpt-plan-not-connected" });
      }
      if (!connection.value.plan_enabled) return err({ kind: "chatgpt-plan-not-enabled" });
    }
    await db("chatgpt_plan_connections")
      .where({ workspace_id: workspaceId.value })
      .update({ usage_source: input.usageSource, updated_at: now() });
    return ok(await view(workspaceId.value, await rowFor(workspaceId.value)));
  }

  async function recordRefresh(
    principal: Principal,
    result: ChatGPTPlanRefreshResult,
  ): Promise<Result<ChatGPTPlanView>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;

    if ("kind" in result) {
      // A terminal refresh error ends the grant; the shopper reauthorizes. A
      // transient network failure is not reported here at all.
      await db("chatgpt_plan_connections")
        .where({ workspace_id: workspaceId.value })
        .update({
          status: "disconnected",
          plan_state: "paused",
          plan_reason: null,
          plan_message: result.message.slice(0, 500),
          disconnected_at: now(),
          updated_at: now(),
        });
      await record(workspaceId.value, "disconnected", result.kind, result.message);
      return ok(await view(workspaceId.value, await rowFor(workspaceId.value)));
    }

    // The rotating pair replaces the previous one together, so a half-applied
    // refresh cannot leave a refresh token that was already consumed.
    const ciphertext = cipher.encrypt(
      JSON.stringify({ accessToken: result.accessToken, refreshToken: result.refreshToken }),
    );
    // A refreshed access token clears the expiry it just replaced; every other
    // observed pause (allowance, eligibility) is left exactly as observed.
    const wasExpired = connection.value.plan_reason === "expired" || isExpired(connection.value, now());
    await db("chatgpt_plan_connections")
      .where({ workspace_id: workspaceId.value })
      .update({
        ciphertext,
        encryption: cipher.encryption,
        expires_at: result.expiresAt,
        status: "connected",
        plan_state: wasExpired ? "available" : connection.value.plan_state,
        plan_reason: wasExpired ? null : connection.value.plan_reason,
        plan_message: wasExpired ? null : connection.value.plan_message,
        last_checked_at: now(),
        updated_at: now(),
      });
    await record(workspaceId.value, "refreshed", null, null);
    return ok(await view(workspaceId.value, await rowFor(workspaceId.value)));
  }

  async function recordOutcome(
    principal: Principal,
    outcome: ChatGPTPlanOutcome,
  ): Promise<Result<ChatGPTPlanView>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;

    const reason: ChatGPTPlanPauseReason | null =
      outcome.kind === "usage-limit-exceeded"
        ? "usage-limit"
        : outcome.kind === "usage-unavailable"
          ? "usage-unavailable"
          : outcome.kind === "not-eligible"
            ? "not-eligible"
            : outcome.kind === "unsupported-capability"
              ? "unsupported-capability"
              : null;
    await db("chatgpt_plan_connections")
      .where({ workspace_id: workspaceId.value })
      .update({
        plan_state: reason ? "paused" : connection.value.plan_state,
        plan_reason: reason ?? connection.value.plan_reason,
        plan_message: outcome.message.slice(0, 500),
        last_checked_at: now(),
        updated_at: now(),
      });
    await record(workspaceId.value, outcome.kind, reason, outcome.message);
    return ok(await view(workspaceId.value, await rowFor(workspaceId.value)));
  }

  async function resolve(
    principal: Principal,
  ): Promise<Result<ResolvedChatGPTPlanRequest>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;
    const row = connection.value;
    if (row.status !== "connected") return err({ kind: "chatgpt-plan-disconnected" });
    if (row.usage_source !== "chatgpt-plan") {
      // The workspace chose API-key billing; the plan is not the payer.
      return err({ kind: "chatgpt-plan-not-connected" });
    }
    if (!row.plan_enabled) return err({ kind: "chatgpt-plan-not-enabled" });
    if (row.plan_state === "paused" && row.plan_reason) {
      // A paused plan never falls through to a stored API key: that would bill
      // an account the shopper did not choose for this turn.
      return err(PAUSE_ERROR[row.plan_reason]);
    }
    if (new Date(row.expires_at).getTime() <= now().getTime()) {
      return err({ kind: "chatgpt-plan-expired" });
    }
    if (!row.selected_model) return err({ kind: "chatgpt-plan-model-not-selected" });
    const tokens = JSON.parse(cipher.decrypt(row.ciphertext)) as Tokens;
    return ok({
      provider: CHATGPT_PLAN_PROVIDER,
      usageSource: "chatgpt-plan",
      modelId: row.selected_model,
      accessToken: tokens.accessToken,
      workspaceId: workspaceId.value,
    });
  }

  async function resolveRefresh(
    principal: Principal,
  ): Promise<Result<{ refreshToken: string; clientId: string }>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;
    if (connection.value.status !== "connected") {
      return err({ kind: "chatgpt-plan-disconnected" });
    }
    const tokens = JSON.parse(cipher.decrypt(connection.value.ciphertext)) as Tokens;
    if (!tokens.refreshToken) return err({ kind: "chatgpt-plan-disconnected" });
    return ok({ refreshToken: tokens.refreshToken, clientId: connection.value.client_id });
  }

  async function exercisePlan(
    principal: Principal,
    input: {
      prompt: string;
      tools?: string[];
      messages?: Array<{ role: "user" | "assistant"; content: string }>;
    },
  ): Promise<Result<ChatGPTPlanExerciseResult & { modelId: string }>> {
    const resolved = await resolve(principal);
    if (!resolved.ok) return resolved;
    const request = resolved.value;
    const exercised = await exercise({
      connection: {
        accessToken: request.accessToken,
        workspaceId: request.workspaceId,
        modelId: request.modelId,
      },
      prompt: input.prompt,
      tools: input.tools ?? ["requirements_update"],
      ...(input.messages && input.messages.length > 0 ? { messages: input.messages } : {}),
    });
    if (!exercised.ok) {
      // A provider failure is recorded against the connection so the screen
      // shows why plan usage stopped, and is then surfaced as a typed error.
      await recordOutcome(principal, {
        kind: exercised.error.kind === "chatgpt-plan-request-failed" ? "request-failed" : "usage-unavailable",
        message: JSON.stringify(exercised.error).slice(0, 500),
      });
      return exercised;
    }
    await recordOutcome(principal, {
      kind: "completed",
      message: `tools: ${exercised.value.toolsExecuted.join(",") || "none"}`,
    });
    return ok({ ...exercised.value, modelId: request.modelId });
  }

  async function disconnect(principal: Principal): Promise<Result<ChatGPTPlanView>> {
    const workspaceId = await admitted(principal);
    if (!workspaceId.ok) return workspaceId;
    const connection = await requireConnection(workspaceId.value);
    if (!connection.ok) return connection;
    await db("chatgpt_plan_connections")
      .where({ workspace_id: workspaceId.value })
      .update({
        status: "disconnected",
        plan_enabled: false,
        usage_source: "api-key",
        selected_model: null,
        selected_model_label: null,
        plan_state: "paused",
        plan_reason: null,
        plan_message: null,
        ciphertext: cipher.encrypt(JSON.stringify({ accessToken: "", refreshToken: "" })),
        encryption: cipher.encryption,
        disconnected_at: now(),
        updated_at: now(),
      });
    await record(workspaceId.value, "disconnected", null, "disconnected by the shopper");
    return ok(await view(workspaceId.value, await rowFor(workspaceId.value)));
  }

  return {
    beginConsent,
    completeConsent,
    read,
    selectModel,
    setUsageSource,
    recordRefresh,
    recordOutcome,
    resolve,
    resolveRefresh,
    exercisePlan,
    disconnect,
  };
}
