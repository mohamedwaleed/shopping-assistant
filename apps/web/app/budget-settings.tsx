// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";
import type { BudgetLimits, BudgetPause, BudgetPoolView, BudgetUsageView } from "@shopping/core";
import { dictionaries, type Dictionary, type Lang } from "@/lib/i18n";

/** Which limit a form field edits; the three units are the same shape. */
const UNITS = ["maxCalls", "maxTokens", "maxCents"] as const;
type Unit = (typeof UNITS)[number];

type EditableLimits = Record<Unit, string>;

function toEditable(limits: BudgetLimits | null): EditableLimits {
  return {
    maxCalls: String(limits?.maxCalls ?? 0),
    maxTokens: String(limits?.maxTokens ?? 0),
    maxCents: String(limits?.maxCents ?? 0),
  };
}

function fromEditable(values: EditableLimits): BudgetLimits {
  return {
    maxCalls: Number(values.maxCalls),
    maxTokens: Number(values.maxTokens),
    maxCents: Number(values.maxCents),
  };
}

function unitLabel(unit: Unit, t: Dictionary): string {
  switch (unit) {
    case "maxCalls":
      return t.budgetCalls;
    case "maxTokens":
      return t.budgetTokens;
    case "maxCents":
      return t.budgetCents;
  }
}

function poolLabel(pool: BudgetPoolView["pool"], t: Dictionary): string {
  return pool === "interactive" ? t.budgetPoolInteractive : t.budgetPoolBackground;
}

/** A pause reason is always shown in words, never as a bare code. */
function pauseLabel(pause: BudgetPause, t: Dictionary): string {
  switch (pause.reason) {
    case "calls-exhausted":
      return t.budgetPauseCalls;
    case "tokens-exhausted":
      return t.budgetPauseTokens;
    case "spend-exhausted":
      return t.budgetPauseSpend;
  }
}

function errorMessage(kind: string | undefined, t: Dictionary): string {
  switch (kind) {
    case "budget-exhausted":
      return t.errorBudgetExhausted;
    case "budget-consent-required":
      return t.errorBudgetConsentRequired;
    case "paid-fallback-not-enabled":
      return t.errorPaidFallbackNotEnabled;
    case "budget-retry-exhausted":
      return t.errorBudgetRetryExhausted;
    case "invalid-input":
      return t.errorInvalidInput;
    case "forbidden":
      return t.errorForbiddenAdmin;
    default:
      return t.errorGeneric;
  }
}

export function BudgetSettings({
  lang,
  canManage,
  view,
}: {
  lang: Lang;
  canManage: boolean;
  view: BudgetUsageView;
}) {
  const t = dictionaries[lang];
  const [current, setCurrent] = useState<BudgetUsageView>(view);
  const [scope, setScope] = useState<"installation" | "workspace">("installation");
  const [draft, setDraft] = useState<Record<string, EditableLimits>>(() =>
    Object.fromEntries(
      current.pools.map((pool) => [
        pool.pool,
        toEditable(scope === "installation" ? pool.installation : (pool.workspace ?? pool.installation)),
      ]),
    ),
  );
  const [status, setStatus] = useState<{ tone: "info" | "error"; message: string } | null>(null);
  const [pending, setPending] = useState<"save" | "consent" | null>(null);

  function switchScope(next: "installation" | "workspace") {
    setScope(next);
    setDraft(
      Object.fromEntries(
        current.pools.map((pool) => [
          pool.pool,
          toEditable(next === "installation" ? pool.installation : (pool.workspace ?? pool.installation)),
        ]),
      ),
    );
    setStatus(null);
  }

  async function send(url: string, body: unknown, key: "save" | "consent") {
    setPending(key);
    setStatus(null);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as BudgetUsageView & { error?: { kind: string } };
      if (!res.ok) {
        setStatus({ tone: "error", message: errorMessage(payload.error?.kind, t) });
        return;
      }
      setCurrent(payload);
      setStatus({ tone: "info", message: t.budgetSaved });
    } finally {
      setPending(null);
    }
  }

  async function save() {
    // Each pool is its own allowance row, so both are saved together.
    for (const pool of current.pools) {
      const limits = { pool: pool.pool, ...fromEditable(draft[pool.pool] ?? toEditable(null)) };
      await send(
        "/api/settings/budgets",
        scope === "installation" ? { installation: limits } : { workspace: limits },
        "save",
      );
    }
  }

  return (
    <section className="panel" aria-labelledby="budgets-title">
      <h2 id="budgets-title">{t.budgetsTitle}</h2>
      <p className="muted">{t.budgetsIntro}</p>

      {canManage && (
        <div className="scope-tabs" role="tablist" aria-label={t.budgetsTitle}>
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

      {status && (
        <div className={`notice notice-${status.tone}`} role="status">
          {status.message}
        </div>
      )}

      <div className="budget-grid">
        {current.pools.map((pool) => (
          <article className="budget-card" key={pool.pool}>
            <header>
              <h3>{poolLabel(pool.pool, t)}</h3>
              <span className={pool.paused ? "cap-badge cap-unsupported" : "cap-badge cap-supported"}>
                {pool.paused ? t.budgetPaused : t.budgetActive}
              </span>
            </header>

            {pool.paused && (
              <div className="notice notice-error" role="alert">
                {pauseLabel(pool.paused, t)}
              </div>
            )}

            <p className="hint">
              {t.budgetCeiling}: {pool.installation.maxCalls} {t.budgetCalls} ·{" "}
              {pool.installation.maxTokens} {t.budgetTokens} · {pool.installation.maxCents}{" "}
              {t.budgetCents}
            </p>
            <p className="hint">
              {t.budgetEffective}: {pool.effective.maxCalls} {t.budgetCalls} ·{" "}
              {pool.effective.maxTokens} {t.budgetTokens} · {pool.effective.maxCents}{" "}
              {t.budgetCents}
            </p>
            {pool.clamped && <p className="notice notice-info">{t.budgetClampedNotice}</p>}
            <p className="muted">
              {t.budgetUsage}: {pool.usage.calls} {t.budgetCalls} · {pool.usage.tokens}{" "}
              {t.budgetTokens} · {pool.usage.cents} {t.budgetCents}
              {pool.usage.inFlightCalls > 0
                ? ` · ${pool.usage.inFlightCalls} ${t.budgetInFlight}`
                : ""}
            </p>
            <p className="hint">
              {t.budgetWindowEnds}: {new Date(pool.window.endsAt).toLocaleString(lang)}
            </p>

            {UNITS.map((unit) => (
              <div className="field" key={unit}>
                <label htmlFor={`${pool.pool}-${unit}`}>{unitLabel(unit, t)}</label>
                <input
                  id={`${pool.pool}-${unit}`}
                  className="input"
                  type="number"
                  min={0}
                  value={draft[pool.pool]?.[unit] ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      [pool.pool]: {
                        ...(draft[pool.pool] ?? toEditable(null)),
                        [unit]: event.target.value,
                      },
                    })
                  }
                />
              </div>
            ))}
          </article>
        ))}
      </div>

      <p className="hint">{t.budgetCeilingNote}</p>
      <button type="button" className="btn-primary" onClick={save} disabled={pending !== null}>
        {pending === "save" ? t.budgetSaving : t.budgetSave}
      </button>

      <div className="capability-block">
        <h3>{t.budgetConsentTitle}</h3>
        <p className="muted">{t.budgetConsentHint}</p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={current.consent.backgroundPersonalKey}
            disabled={pending !== null}
            onChange={(event) =>
              void send(
                "/api/settings/budgets/consent",
                { backgroundAllowed: event.target.checked },
                "consent",
              )
            }
          />
          {t.budgetConsentAllow}
        </label>
      </div>

      <div className="capability-block">
        <h3>{t.budgetFallbackTitle}</h3>
        <p className="muted">
          {current.fallback.workspaceMayRequest
            ? t.budgetFallbackMayRequest
            : t.budgetFallbackNotEnabled}
        </p>
      </div>

      <div className="capability-block">
        <h3>{t.budgetEstimateTitle}</h3>
        <p className="muted">{current.estimates.assumption}</p>
        <p className="hint">
          {t.budgetEstimateBasis}: {current.estimates.defaults.maxCalls} {t.budgetCalls} ·{" "}
          {current.estimates.defaults.maxTokens} {t.budgetTokens} ·{" "}
          {current.estimates.defaults.maxCents} {t.budgetCents}
        </p>
        <p className="hint">
          {t.budgetEstimateCeilings}: {current.estimates.ceilings.maxCalls} {t.budgetCalls} ·{" "}
          {current.estimates.ceilings.maxTokens} {t.budgetTokens} ·{" "}
          {current.estimates.ceilings.maxCents} {t.budgetCents}
        </p>
      </div>

      <p className="hint">
        {t.budgetContinue}: {t.budgetContinueHint}
      </p>
    </section>
  );
}
