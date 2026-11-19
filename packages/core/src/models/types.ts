// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Result } from "../errors";
import type { PlanAccessView } from "./plan-access";

/**
 * Vercel AI SDK providers this installation supports, pinned in
 * docs/adr/0012. `compatible` is any OpenAI-compatible or local endpoint; its
 * capabilities are never assumed from that label (see ModelProbe).
 */
export const MODEL_PROVIDERS = ["openai", "anthropic", "compatible"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Which account pays for a call. Never inferred: it is stored with the config. */
export type UsageSource = "installation" | "workspace";

/** Model roles: one conversational default plus optional narrower overrides. */
export type ModelRole = "default" | "extraction";

export interface ModelTarget {
  provider: ModelProvider;
  modelId: string;
  /** Required for `compatible`; the base URL of an OpenAI-compatible endpoint. */
  endpoint?: string;
}

/** A resolved model plus the credential it must use. Server-side only. */
export interface ResolvedModel extends ModelTarget {
  role: ModelRole;
  /** Where the configuration came from. */
  source: "installation" | "workspace";
  usageSource: UsageSource;
  apiKey: string;
}

export interface ModelCredentialSummary {
  source: "installation" | "workspace";
  /** Masked hint such as "sk-…-key"; never the secret itself. */
  masked: string;
}

export interface ModelConfigurationView {
  defaultModel: ModelTarget | null;
  extractionModel: ModelTarget | null;
  usageSource: UsageSource | null;
  credential: ModelCredentialSummary | null;
}

/** The effective configuration names where it came from and which account pays. */
export interface EffectiveModelConfigurationView extends ModelConfigurationView {
  source: "installation" | "workspace";
}

export type CapabilityState = "supported" | "unsupported";

export interface DiagnosticBounds {
  /** Model calls the diagnostic may make in total. */
  maxCalls: number;
  /** Output tokens requested per call. */
  maxOutputTokens: number;
}

/**
 * A diagnostic never runs unbounded: these ceilings are code, not convention,
 * and apply even when the caller asks for more.
 */
export const DEFAULT_DIAGNOSTIC_BOUNDS: DiagnosticBounds = {
  maxCalls: 4,
  maxOutputTokens: 64,
};
export const MAX_DIAGNOSTIC_CALLS = 8;
export const MAX_DIAGNOSTIC_OUTPUT_TOKENS = 512;

export interface CapabilityReport {
  provider: ModelProvider;
  modelId: string;
  endpoint?: string;
  testedAt: string;
  bounds: DiagnosticBounds;
  capabilities: {
    text: CapabilityState;
    tools: CapabilityState;
    structuredOutput: CapabilityState;
    streaming: CapabilityState;
  };
  /** Absent when every probe step completed. */
  error?: { kind: string; message: string };
}

export interface ModelProbeRequest {
  target: ModelTarget;
  /** The provider the credential belongs to; the adapter refuses a mismatch. */
  provider: ModelProvider;
  apiKey: string;
  bounds: DiagnosticBounds;
}

/**
 * The AI SDK adapter implements this; core owns the bounds and the record. A
 * refused request is a typed error, never a thrown exception: a provider that
 * cannot be probed is configuration feedback, not a server fault.
 */
export type ModelProbe = (
  request: ModelProbeRequest,
) => Promise<Result<CapabilityReport>>;

export interface ModelConfigurationViewResult {
  installation: ModelConfigurationView;
  /** Null when the workspace has no override of its own. */
  workspace: ModelConfigurationView | null;
  /** The configuration that actually serves this workspace, masked. */
  effective: EffectiveModelConfigurationView | null;
  capability: CapabilityReport | null;
  diagnostics: { bounds: DiagnosticBounds; limits: DiagnosticBounds };
  /**
   * Whether a Claude plan may be spent by this deployment. Reported next to the
   * API-key configuration and never conflated with it: it is read-only, derived
   * from the route declaration rather than stored (docs/adr/0013).
   */
  planAccess: PlanAccessView;
}

export interface SaveModelConfiguration {
  defaultModel: ModelTarget | null;
  usageSource: UsageSource;
  extractionOverride: ModelTarget | null;
  /** A new key to store; null keeps any stored key. */
  apiKey: string | null;
  clearCredential?: boolean;
}
