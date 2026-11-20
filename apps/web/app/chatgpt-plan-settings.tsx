// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";
import type {
  ChatGPTPlanEligibility,
  ChatGPTPlanPauseReason,
  ChatGPTPlanConnectionStatus,
  ChatGPTPlanUsageSource,
  ChatGPTPlanView,
} from "@shopping/core";
import { dictionaries, type Dictionary, type Lang } from "@/lib/i18n";
import { formatObservedAt } from "@/lib/format";

const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";

function statusLabel(status: ChatGPTPlanConnectionStatus, t: Dictionary): string {
  switch (status) {
    case "connected":
      return t.planStatusConnected;
    case "plan-disabled":
      return t.planStatusPlanDisabled;
    case "disconnected":
      return t.planStatusDisconnected;
  }
}

function eligibilityLabel(eligibility: ChatGPTPlanEligibility, t: Dictionary): string {
  switch (eligibility) {
    case "eligible":
      return t.planEligibilityEligible;
    case "not-enabled":
      return t.planEligibilityNotEnabled;
    case "expired":
      return t.planEligibilityExpired;
    case "not-eligible":
      return t.planEligibilityNotEligible;
    case "unavailable":
      return t.planEligibilityUnavailable;
    case "disconnected":
      return t.planEligibilityDisconnected;
  }
}

function pauseLabel(reason: ChatGPTPlanPauseReason, t: Dictionary): string {
  switch (reason) {
    case "usage-limit":
      return t.planReasonUsageLimit;
    case "not-eligible":
      return t.planReasonNotEligible;
    case "usage-unavailable":
      return t.planReasonUnavailable;
    case "unsupported-capability":
      return t.planReasonUnsupported;
    case "expired":
      return t.planReasonExpired;
  }
}

function errorMessage(kind: string | undefined, t: Dictionary): string {
  switch (kind) {
    case "chatgpt-plan-not-connected":
      return t.errorPlanNotConnected;
    case "chatgpt-plan-disconnected":
      return t.errorPlanDisconnected;
    case "chatgpt-plan-not-enabled":
      return t.errorPlanNotEnabled;
    case "chatgpt-plan-expired":
      return t.errorPlanExpired;
    case "chatgpt-plan-usage-limit":
      return t.errorPlanUsageLimit;
    case "chatgpt-plan-model-not-selected":
      return t.errorPlanModelNotSelected;
    case "chatgpt-plan-model-unavailable":
      return t.errorPlanModelUnavailable;
    case "chatgpt-plan-consent-declined":
      return t.errorPlanConsentDeclined;
    case "chatgpt-plan-request-failed":
      return t.errorPlanRequestFailed;
    case "invalid-origin":
      return t.errorInvalidOrigin;
    case "invalid-input":
      return t.errorInvalidInput;
    default:
      return t.errorGeneric;
  }
}

interface ConsentAttempt {
  authorizationUrl: string;
  state: string;
  codeChallenge: string;
  /** The PKCE verifier for this attempt; the callback must present it back. */
  codeVerifier: string;
  scope: string[];
}

/**
 * The ChatGPT plan connection for this workspace. Everything shown here comes
 * from the masked eligibility view core returns: no token, ciphertext or client
 * id reaches the browser, and the usage source is always displayed so nobody
 * has to guess which account pays.
 */
export function ChatGPTPlanSettings({
  lang,
  initial,
}: {
  lang: Lang;
  initial: ChatGPTPlanView;
}) {
  const t = dictionaries[lang];
  const [view, setView] = useState<ChatGPTPlanView>(initial);
  const [modelId, setModelId] = useState(initial.selectedModel?.modelId ?? "");
  const [status, setStatus] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const [pending, setPending] = useState<"connect" | "model" | "exercise" | "refresh" | "disconnect" | "source" | null>(null);

  async function call(
    path: string,
    body: unknown,
    method: "POST" | "PUT" = "POST",
  ): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; kind?: string }> {
    try {
      const res = await fetch(`/api/settings/chatgpt-plan${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const error = payload.error as { kind?: string } | undefined;
        return { ok: false, ...(error?.kind ? { kind: error.kind } : {}) };
      }
      return { ok: true, payload };
    } catch {
      return { ok: false };
    }
  }

  async function refreshView() {
    const res = await fetch("/api/settings/chatgpt-plan");
    if (res.ok) setView((await res.json()) as ChatGPTPlanView);
  }

  async function connect() {
    setPending("connect");
    setStatus(null);
    const started = await call("/consent", {});
    if (!started.ok) {
      setStatus({ tone: "error", message: errorMessage(started.kind, t) });
      setPending(null);
      return;
    }
    const attempt = started.payload as unknown as ConsentAttempt;
    // The consent screen is the provider's own; this installation never sees
    // the shopper's ChatGPT password or conversations.
    window.location.assign(attempt.authorizationUrl);
  }

  async function chooseModel() {
    setPending("model");
    setStatus(null);
    const saved = await call(
      "/model",
      {
        modelId,
        ...(view.models.length > 0 ? { available: view.models } : {}),
      },
      "PUT",
    );
    setPending(null);
    if (!saved.ok) {
      setStatus({ tone: "error", message: errorMessage(saved.kind, t) });
      return;
    }
    await refreshView();
    setStatus({ tone: "info", message: t.savedModels });
  }

  async function changeUsageSource(usageSource: ChatGPTPlanUsageSource) {
    setPending("source");
    setStatus(null);
    const saved = await call("/usage-source", { usageSource }, "PUT");
    setPending(null);
    if (!saved.ok) {
      setStatus({ tone: "error", message: errorMessage(saved.kind, t) });
      return;
    }
    await refreshView();
  }

  async function exercise() {
    setPending("exercise");
    setStatus(null);
    const tested = await call("/exercise", {});
    setPending(null);
    if (!tested.ok) {
      setStatus({ tone: "error", message: errorMessage(tested.kind, t) });
      await refreshView();
      return;
    }
    const executed = Array.isArray(tested.payload.toolsExecuted) ? tested.payload.toolsExecuted.length : 0;
    setStatus({
      tone: executed > 0 ? "info" : "error",
      message: executed > 0 ? t.planExercisePassed : t.planExerciseTextOnly,
    });
    await refreshView();
  }

  async function refresh() {
    setPending("refresh");
    setStatus(null);
    const refreshed = await call("/refresh", {});
    setPending(null);
    if (!refreshed.ok) {
      setStatus({ tone: "error", message: errorMessage(refreshed.kind, t) });
      return;
    }
    await refreshView();
  }

  async function disconnect() {
    setPending("disconnect");
    setStatus(null);
    const removed = await call("/disconnect", {});
    setPending(null);
    if (!removed.ok) {
      setStatus({ tone: "error", message: errorMessage(removed.kind, t) });
      return;
    }
    await refreshView();
  }

  const connected = view.status !== "disconnected";

  return (
    <section className="panel" aria-labelledby="plan-title">
      <h2 id="plan-title">{t.planTitle}</h2>
      <p className="muted">{t.planIntro}</p>

      {status && (
        <div className={`notice notice-${status.tone}`} role="status">
          {status.message}
        </div>
      )}

      <div className="attr-grid">
        <div className="field">
          <span className="hint">{t.planStatusLabel}</span>
          <strong>{statusLabel(view.status, t)}</strong>
        </div>
        <div className="field">
          <span className="hint">{t.planEligibilityLabel}</span>
          <strong>{eligibilityLabel(view.eligibility, t)}</strong>
        </div>
        <div className="field">
          <span className="hint">{t.planUsageSourceLabel}</span>
          <strong>
            {view.usageSource === "chatgpt-plan" ? t.planUsageSourcePlan : t.planUsageSourceKey}
          </strong>
        </div>
        {view.account && (
          <div className="field">
            <span className="hint">{t.planAccountLabel}</span>
            <strong>
              {view.account.emailHint ?? t.planAccountSubject}
            </strong>
            <span className="hint">
              {t.planAccountSubject}: {view.account.subject.slice(0, 8)}…
            </span>
          </div>
        )}
        {view.expiresAt && (
          <div className="field">
            <span className="hint">{t.planExpiresAt}</span>
            <strong>{formatObservedAt(view.expiresAt, lang)}</strong>
          </div>
        )}
      </div>

      <p className="muted">
        {view.apiKey.configured
          ? `${t.planApiKeyConfigured}: ${view.apiKey.provider ?? ""} · ${view.apiKey.modelId ?? ""}`
          : t.planNoApiKey}
      </p>

      {view.usageSource === "chatgpt-plan" && (
        <div className="field">
          <span className="hint">{t.planQuotaTitle}</span>
          <strong>
            {view.plan.state === "paused" ? t.planQuotaPaused : t.planQuotaAvailable}
          </strong>
          {view.plan.state === "paused" && view.plan.reason && (
            <span className="hint">{pauseLabel(view.plan.reason, t)}</span>
          )}
          {view.plan.state === "paused" && view.plan.reason === "usage-limit" && (
            <a className="btn-quiet" href={MANAGE_USAGE_URL} target="_blank" rel="noreferrer">
              {t.planManageUsage}
            </a>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor="plan-usage-source">{t.planUsageSourceLabel}</label>
        <select
          id="plan-usage-source"
          className="input"
          value={view.usageSource}
          onChange={(event) => void changeUsageSource(event.target.value as ChatGPTPlanUsageSource)}
          disabled={!connected || pending !== null}
        >
          <option value="chatgpt-plan" disabled={view.eligibility === "not-enabled"}>
            {t.planUsageSourcePlan}
          </option>
          <option value="api-key">{t.planUsageSourceKey}</option>
        </select>
        <span className="hint">{t.planUsageSourceHint}</span>
      </div>

      {!connected && (
        <>
          <button type="button" className="btn-primary" onClick={connect} disabled={pending !== null}>
            {t.planConnect}
          </button>
          <p className="hint">{t.planConnectHint}</p>
        </>
      )}

      {connected && (
        <>
          <div className="field">
            <label htmlFor="plan-model">{t.planModelLabel}</label>
            {view.models.length > 0 ? (
              <select
                id="plan-model"
                className="input"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                {view.models.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="plan-model"
                className="input"
                type="text"
                value={modelId}
                placeholder={view.selectedModel?.modelId ?? ""}
                onChange={(event) => setModelId(event.target.value)}
              />
            )}
            <span className="hint">{t.planModelHint}</span>
          </div>
          <div>
            <button type="button" className="btn-quiet" onClick={chooseModel} disabled={pending !== null || !modelId}>
              {t.planModelSave}
            </button>
            <button type="button" className="btn-quiet" onClick={exercise} disabled={pending !== null}>
              {pending === "exercise" ? t.planExerciseRunning : t.planExercise}
            </button>
            <button type="button" className="btn-quiet" onClick={refresh} disabled={pending !== null}>
              {t.planRefresh}
            </button>
            <button type="button" className="btn-quiet" onClick={disconnect} disabled={pending !== null}>
              {t.planDisconnect}
            </button>
          </div>
        </>
      )}

      <div className="notice notice-info" role="note">
        <strong>{t.planEntitlementTitle}</strong>
        <p>{t.planEntitlementUnresolved}</p>
        <a href="/model-access">{t.planEntitlementDocs}</a>
      </div>

      {view.events.length > 0 && (
        <ul className="hint">
          {view.events.map((event, index) => (
            <li key={`${event.observedAt}-${index}`}>
              {event.kind} · {formatObservedAt(event.observedAt, lang)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
