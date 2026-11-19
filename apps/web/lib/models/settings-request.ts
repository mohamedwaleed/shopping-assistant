// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MODEL_PROVIDERS,
  type ModelProvider,
  type ModelTarget,
  type SaveModelConfiguration,
  type UsageSource,
} from "@shopping/core/models/types";

/**
 * Translate a settings request body into a core save request. Only known fields
 * are read; anything else (an installation id, another workspace id) is ignored
 * here and refused by core, which owns authorization.
 */
export function saveRequestFrom(body: Record<string, unknown>): SaveModelConfiguration {
  return {
    defaultModel: targetFrom(body.defaultModel),
    usageSource: usageSourceFrom(body.usageSource ?? body.usageSourceChoice),
    extractionOverride: targetFrom(body.extractionModel),
    apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null,
    clearCredential: body.clearCredential === true,
  };
}

function targetFrom(value: unknown): ModelTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const provider = record.provider;
  const modelId = record.modelId;
  if (typeof provider !== "string" || typeof modelId !== "string") {
    // Hand the raw shape to core so it reports the field that is wrong.
    return value as ModelTarget;
  }
  return {
    provider: provider as ModelProvider,
    modelId,
    ...(typeof record.endpoint === "string" ? { endpoint: record.endpoint } : {}),
  };
}

function usageSourceFrom(value: unknown): UsageSource {
  return value === "workspace" ? "workspace" : "installation";
}

/** The providers the settings form offers; core owns the supported list. */
export const PROVIDER_OPTIONS: ReadonlyArray<ModelProvider> = MODEL_PROVIDERS;
