// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Result } from "../errors";
import type { ModelProvider } from "./types";

/**
 * ChatGPT plan usage is a provider OAuth capability separate from application
 * sign-in (docs/adr/0013). Everything here is server-side vocabulary: the
 * browser only ever sees the masked eligibility view.
 */
export const CHATGPT_PLAN_PROVIDER = "chatgpt-plan";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_PLAN_RESOURCE = "https://api.openai.com/v1";

/** Scopes requested from the official OSS flow, in the documented order. */
export const CHATGPT_PLAN_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  CHATGPT_PLAN_SCOPE,
] as const;

/**
 * The unresolved entitlement gate this installation cannot close by itself.
 * Official documentation permits ChatGPT plan usage for open-source projects
 * and locally run personal projects and directs paid or remotely hosted apps to
 * request access first; no approval is held for this installation, so the
 * screens and docs say so instead of implying an entitlement.
 */
export const CHATGPT_PLAN_ENTITLEMENT = {
  status: "unresolved",
  reason: "no-provider-approval-for-remotely-hosted-deployments",
  documentedAt: "docs/model-access-design.md",
} as const;

export interface ChatGPTPlanEntitlement {
  status: "unresolved";
  reason: "no-provider-approval-for-remotely-hosted-deployments";
  documentedAt: string;
}

/** Where a workspace's inference is billed. Never inferred from availability. */
export type ChatGPTPlanUsageSource = "chatgpt-plan" | "api-key";

export type ChatGPTPlanStatus = "connected" | "disconnected";

/**
 * A grant without the plan scope keeps the provider sign-in but leaves plan
 * usage disabled until the shopper enables it explicitly.
 */
export type ChatGPTPlanConnectionStatus = ChatGPTPlanStatus | "plan-disabled";

/**
 * Eligibility answers "can this connection serve a shopping request now?" and
 * is deliberately finer than `status`: an exhausted allowance or an ineligible
 * account keeps the connection but pauses plan usage visibly.
 */
export type ChatGPTPlanEligibility =
  | "eligible"
  | "not-enabled"
  | "expired"
  | "not-eligible"
  | "unavailable"
  | "disconnected";

export type ChatGPTPlanPauseReason =
  | "usage-limit"
  | "usage-unavailable"
  | "not-eligible"
  | "unsupported-capability"
  | "expired";

export interface ChatGPTPlanState {
  state: "available" | "paused";
  reason: ChatGPTPlanPauseReason | null;
  /** Provider diagnostic text; never a token. */
  message: string | null;
  retryAfterSeconds: number | null;
}

export interface ChatGPTPlanAccount {
  /** Validated ID-token subject; the provider identity, not an app user. */
  subject: string;
  /** Masked hint only. Never used to match an application account. */
  emailHint: string | null;
}

export interface ChatGPTPlanModel {
  modelId: string;
  displayName: string;
}

/** A token grant exactly as the token endpoint returns it. Server-side only. */
export interface ChatGPTPlanTokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  /** Granted scopes from the token response, not the requested ones. */
  scopes: string[];
  account: { subject: string; email: string | null };
  clientId: string;
}

/** The refresh outcome: a new pair, or a terminal error that ends the grant. */
export type ChatGPTPlanRefreshResult =
  | { accessToken: string; refreshToken: string; expiresAt: Date }
  | { kind: "invalid_grant" | "invalid_client"; message: string };

/** Observed Responses-layer outcome, mapped from the provider's error code. */
export type ChatGPTPlanOutcome =
  | { kind: "usage-limit-exceeded"; message: string }
  | { kind: "usage-unavailable"; message: string }
  | { kind: "not-eligible"; message: string }
  | { kind: "unsupported-capability"; message: string }
  | { kind: "request-failed"; message: string }
  | { kind: "completed"; message: string };

/** A resolved plan request: the account's token and the account's model. */
export interface ResolvedChatGPTPlanRequest {
  provider: typeof CHATGPT_PLAN_PROVIDER;
  usageSource: "chatgpt-plan";
  modelId: string;
  accessToken: string;
  workspaceId: string;
}

/**
 * What a plan call must prove. The adapter returns the observed facts; core
 * records them, so a text-only answer is never reported as a working tool step.
 */
export interface ChatGPTPlanExercise {
  connection: { accessToken: string; workspaceId: string; modelId: string };
  prompt: string;
  tools: string[];
  /**
   * The shopper's turn and any history the caller already holds. The plan route
   * rejects `previous_response_id`, so the conversation travels in `input`.
   */
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ChatGPTPlanExerciseResult {
  completed: boolean;
  text: string;
  toolCalls: string[];
  toolsExecuted: string[];
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

export type ChatGPTPlanExerciseFn = (
  request: ChatGPTPlanExercise,
) => Promise<Result<ChatGPTPlanExerciseResult>>;

export interface ChatGPTPlanConsentAttempt {
  authorizationUrl: string;
  state: string;
  codeChallenge: string;
  scope: string[];
  /** Stable per-installation agent host identifier (urn:uuid:…). */
  hostId: string;
  /** Kept server-side only; never serialized into a response. */
  codeVerifier: string;
  entitlement: ChatGPTPlanEntitlement;
}

/** The masked eligibility view the settings and chat screens render. */
export interface ChatGPTPlanView {
  status: ChatGPTPlanConnectionStatus;
  eligibility: ChatGPTPlanEligibility;
  usageSource: ChatGPTPlanUsageSource;
  account: ChatGPTPlanAccount | null;
  selectedModel: ChatGPTPlanModel | null;
  /** Account-specific list from the last discovery; empty until discovered. */
  models: ChatGPTPlanModel[];
  plan: ChatGPTPlanState;
  expiresAt: string | null;
  scopes: string[];
  lastCheckedAt: string | null;
  /** The API-key configuration that exists, shown so billing is never a guess. */
  apiKey: {
    configured: boolean;
    provider: ModelProvider | null;
    modelId: string | null;
    source: "installation" | "workspace" | null;
  };
  entitlement: ChatGPTPlanEntitlement;
  events: Array<{ kind: string; reason: string | null; observedAt: string }>;
}
