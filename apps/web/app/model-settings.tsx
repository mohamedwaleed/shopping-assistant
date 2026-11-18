// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";
import type {
  CapabilityReport,
  CapabilityState,
  DiagnosticBounds,
  EffectiveModelConfigurationView,
  ModelConfigurationView,
  ModelConfigurationViewResult,
  ModelProvider,
  ModelTarget,
  UsageSource,
} from "@shopping/core";
import { dictionaries, type Dictionary, type Lang } from "@/lib/i18n";
import { formatObservedAt } from "@/lib/format";

type Scope = "installation" | "workspace";

interface FormTarget {
  provider: ModelProvider;
  modelId: string;
  endpoint: string;
}

const EMPTY_TARGET: FormTarget = { provider: "openai", modelId: "", endpoint: "" };

function targetToForm(target: ModelTarget | null): FormTarget {
  return target
    ? { provider: target.provider, modelId: target.modelId, endpoint: target.endpoint ?? "" }
    : EMPTY_TARGET;
}

function formToTarget(form: FormTarget): ModelTarget | null {
  const modelId = form.modelId.trim();
  if (!modelId) return null;
  const endpoint = form.endpoint.trim();
  return {
    provider: form.provider,
    modelId,
    ...(endpoint ? { endpoint } : {}),
  };
}

function capabilityLabel(state: CapabilityState, t: Dictionary): string {
  return state === "supported" ? t.capabilitySupported : t.capabilityUnsupported;
}

function CapabilityBadge({ state, t }: { state: CapabilityState; t: Dictionary }) {
  return (
    <span className={`cap-badge cap-${state}`}>{capabilityLabel(state, t)}</span>
  );
}

export function ModelSettingsForm({
  lang,
  canManage,
  view,
  bounds,
}: {
  lang: Lang;
  canManage: boolean;
  view: ModelConfigurationViewResult;
  bounds: DiagnosticBounds;
}) {
  const t = dictionaries[lang];
  const [scope, setScope] = useState<Scope>("installation");
  const [installation, setInstallation] = useState<ModelConfigurationView>(view.installation);
  const [workspace, setWorkspace] = useState<ModelConfigurationView | null>(view.workspace);
  const [effective, setEffective] = useState<EffectiveModelConfigurationView | null>(view.effective);
  const [capability, setCapability] = useState<CapabilityReport | null>(view.capability);
  const [defaultTarget, setDefaultTarget] = useState<FormTarget>(
    targetToForm(view.installation.defaultModel),
  );
  const [extractionTarget, setExtractionTarget] = useState<FormTarget>(
    targetToForm(view.installation.extractionModel),
  );
  const [useExtraction, setUseExtraction] = useState(view.installation.extractionModel !== null);
  const [usageSource, setUsageSource] = useState<UsageSource>(
    view.installation.usageSource ?? "installation",
  );
  const [apiKey, setApiKey] = useState("");
  const [clearCredential, setClearCredential] = useState(false);
  const [status, setStatus] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const [pending, setPending] = useState<"save" | "test" | null>(null);

  const current = scope === "installation" ? installation : workspace;
  const currentCredential = current?.credential ?? null;

  function switchScope(next: Scope) {
    setScope(next);
    const settings = next === "installation" ? installation : workspace;
    setDefaultTarget(targetToForm(settings?.defaultModel ?? null));
    setExtractionTarget(targetToForm(settings?.extractionModel ?? null));
    setUseExtraction(Boolean(settings?.extractionModel));
    setUsageSource(settings?.usageSource ?? "installation");
    setApiKey("");
    setClearCredential(false);
    setStatus(null);
  }

  async function save() {
    setPending("save");
    setStatus(null);
    const body = {
      defaultModel: formToTarget(defaultTarget),
      extractionModel: useExtraction ? formToTarget(extractionTarget) : null,
      usageSource,
      apiKey: apiKey.trim() ? apiKey.trim() : null,
      clearCredential,
    };
    const url =
      scope === "installation"
        ? "/api/settings/models"
        : "/api/settings/models/workspace";
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as {
        installation?: ModelConfigurationView;
        workspace?: ModelConfigurationView;
        error?: { kind: string };
      };
      if (!res.ok) {
        setStatus({ tone: "error", message: errorMessage(payload.error?.kind, t) });
        return;
      }
      if (scope === "installation" && payload.installation) {
        setInstallation(payload.installation);
        if (!workspace) setEffective(effectiveFrom(payload.installation, "installation"));
      }
      if (scope === "workspace" && payload.workspace) {
        setWorkspace(payload.workspace);
        setEffective(effectiveFrom(payload.workspace, "workspace"));
      }
      setCapability(null);
      setApiKey("");
      setClearCredential(false);
      setStatus({ tone: "info", message: t.savedModels });
    } finally {
      setPending(null);
    }
  }

  async function runCapabilityTest() {
    setPending("test");
    setStatus(null);
    try {
      const res = await fetch("/api/settings/models/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bounds),
      });
      const payload = (await res.json()) as {
        capability?: CapabilityReport;
        error?: { kind: string };
      };
      if (!res.ok || !payload.capability) {
        setStatus({ tone: "error", message: errorMessage(payload.error?.kind, t) });
        return;
      }
      setCapability(payload.capability);
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="models-title">
      <h2 id="models-title">{t.modelsTitle}</h2>
      <p className="muted">{t.modelsIntro}</p>

      {canManage && (
        <div className="scope-tabs" role="tablist" aria-label={t.modelsTitle}>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "installation"}
            className={scope === "installation" ? "scope-tab active" : "scope-tab"}
            onClick={() => switchScope("installation")}
          >
            {t.installationDefaults}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === "workspace"}
            className={scope === "workspace" ? "scope-tab active" : "scope-tab"}
            onClick={() => switchScope("workspace")}
          >
            {t.workspaceOverride}
          </button>
        </div>
      )}

      <p className="muted">
        {scope === "installation" ? t.installationDefaultsHint : t.workspaceOverrideHint}
      </p>

      {status && (
        <div className={`notice notice-${status.tone}`} role="status">
          {status.message}
        </div>
      )}

      <div className="field">
        <label htmlFor="provider">{t.providerLabel}</label>
        <select
          id="provider"
          className="input"
          value={defaultTarget.provider}
          onChange={(event) =>
            setDefaultTarget({ ...defaultTarget, provider: event.target.value as ModelProvider })
          }
        >
          <option value="openai">{t.providerOpenai}</option>
          <option value="anthropic">{t.providerAnthropic}</option>
          <option value="compatible">{t.providerCompatible}</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor="modelId">{t.modelIdLabel}</label>
        <input
          id="modelId"
          className="input"
          type="text"
          value={defaultTarget.modelId}
          onChange={(event) => setDefaultTarget({ ...defaultTarget, modelId: event.target.value })}
        />
        <span className="hint">{t.modelIdHint}</span>
      </div>

      <div className="field">
        <label htmlFor="endpoint">{t.endpointLabel}</label>
        <input
          id="endpoint"
          className="input"
          type="url"
          value={defaultTarget.endpoint}
          onChange={(event) => setDefaultTarget({ ...defaultTarget, endpoint: event.target.value })}
        />
        <span className="hint">{t.endpointHint}</span>
      </div>

      <div className="field">
        <label htmlFor="apiKey">{t.apiKeyLabel}</label>
        <input
          id="apiKey"
          className="input"
          type="password"
          autoComplete="off"
          value={apiKey}
          placeholder={currentCredential ? `${t.apiKeyStored}: ${currentCredential.masked}` : t.noKeyStored}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <span className="hint">{t.apiKeyHint}</span>
      </div>

      {currentCredential && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={clearCredential}
            onChange={(event) => setClearCredential(event.target.checked)}
          />
          {t.clearCredentialLabel}
        </label>
      )}

      <div className="field">
        <label htmlFor="usageSource">{t.usageSourceLabel}</label>
        <select
          id="usageSource"
          className="input"
          value={usageSource}
          onChange={(event) => setUsageSource(event.target.value as UsageSource)}
        >
          <option value="installation">{t.usageSourceInstallation}</option>
          <option value="workspace">{t.usageSourceWorkspace}</option>
        </select>
        <span className="hint">{t.usageSourceHint}</span>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={useExtraction}
          onChange={(event) => setUseExtraction(event.target.checked)}
        />
        {t.useExtractionOverride}
      </label>

      {useExtraction && (
        <div className="attr-grid">
          <div className="field">
            <label htmlFor="extractionModel">{t.extractionOverrideLabel}</label>
            <input
              id="extractionModel"
              className="input"
              type="text"
              value={extractionTarget.modelId}
              onChange={(event) =>
                setExtractionTarget({ ...extractionTarget, modelId: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="extractionProvider">{t.providerLabel}</label>
            <select
              id="extractionProvider"
              className="input"
              value={extractionTarget.provider}
              onChange={(event) =>
                setExtractionTarget({
                  ...extractionTarget,
                  provider: event.target.value as ModelProvider,
                })
              }
            >
              <option value="openai">{t.providerOpenai}</option>
              <option value="anthropic">{t.providerAnthropic}</option>
              <option value="compatible">{t.providerCompatible}</option>
            </select>
          </div>
        </div>
      )}
      {useExtraction && <p className="hint">{t.extractionOverrideHint}</p>}

      <button
        type="button"
        className="btn-primary"
        onClick={save}
        disabled={pending !== null}
      >
        {pending === "save" ? t.savingModels : t.saveModels}
      </button>

      <div className="capability-block">
        <h3>{t.capabilityTitle}</h3>
        <p className="muted">{t.capabilityIntro}</p>
        <p className="hint">
          {t.capabilityBounds}: {bounds.maxCalls} {t.capabilityCalls} · {bounds.maxOutputTokens}{" "}
          {t.capabilityTokens}
        </p>
        {effective && (
          <p className="muted">
            {t.effectiveModel}: <strong>{effective.defaultModel?.modelId}</strong> ·{" "}
            {effective.source === "workspace" ? t.effectiveFromWorkspace : t.effectiveFromInstallation}
          </p>
        )}
        {capability ? (
          <>
            <div className="cap-grid">
              {(
                [
                  ["text", t.capabilityText],
                  ["tools", t.capabilityTools],
                  ["structuredOutput", t.capabilityStructured],
                  ["streaming", t.capabilityStreaming],
                ] as const
              ).map(([key, label]) => (
                <div className="cap-cell" key={key}>
                  <span>{label}</span>
                  <CapabilityBadge state={capability.capabilities[key]} t={t} />
                </div>
              ))}
            </div>
            <p className="hint">
              {t.capabilityTestedAt}: {formatObservedAt(capability.testedAt, lang)}
            </p>
            {capability.error && (
              <div className="notice notice-error" role="alert">
                {t.capabilityFailed}: {capability.error.message}
              </div>
            )}
          </>
        ) : (
          <p className="muted">{t.capabilityNeverRun}</p>
        )}
        {canManage && (
          <button
            type="button"
            className="btn-quiet"
            onClick={runCapabilityTest}
            disabled={pending !== null}
          >
            {pending === "test" ? t.capabilityRunning : t.capabilityRun}
          </button>
        )}
      </div>
    </section>
  );
}

function effectiveFrom(
  settings: ModelConfigurationView,
  source: Scope,
): EffectiveModelConfigurationView | null {
  if (!settings.defaultModel) return null;
  return { ...settings, source };
}

function errorMessage(kind: string | undefined, t: Dictionary): string {
  switch (kind) {
    case "model-not-configured":
      return t.errorModelNotConfigured;
    case "model-credential-missing":
      return t.errorModelCredentialMissing;
    case "provider-unavailable":
      return t.errorProviderUnavailable;
    case "invalid-input":
      return t.errorInvalidInput;
    case "forbidden":
      return t.errorForbiddenAdmin;
    default:
      return t.errorGeneric;
  }
}
