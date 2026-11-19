// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { MailSettingsView } from "@shopping/core";
import type { Lang } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n";
import { emailFailureStageLabel } from "@/lib/auth/messages";
import { formatObservedAt } from "@/lib/format";

export interface EmailSettingsState {
  tone: "success" | "error";
  message: string;
}

export type EmailSettingsAction = (
  state: EmailSettingsState,
  formData: FormData,
) => Promise<EmailSettingsState>;

const INITIAL: EmailSettingsState = { tone: "success", message: "" };

function StatusPanel({ settings, lang }: { settings: MailSettingsView; lang: Lang }) {
  const t = dictionaries[lang];
  const status = !settings.configured
    ? { label: t.emailStatusUnconfigured, tone: "info", body: t.emailStatusUnconfiguredBody }
    : settings.failure
      ? { label: t.emailStatusFailing, tone: "error", body: t.emailStatusFailingBody }
      : { label: t.emailStatusReady, tone: "success", body: t.emailStatusReadyBody };

  return (
    <div className={`email-status email-status-${status.tone}`} role="status">
      <div className="email-status-head">
        <strong>{status.label}</strong>
      </div>
      <p className="muted">{status.body}</p>
      {settings.failure && (
        <dl className="email-failure">
          <dt>{t.emailFailureStageLabel}</dt>
          <dd>{emailFailureStageLabel(settings.failure.stage, t)}</dd>
          <dt>{t.emailFailureReasonLabel}</dt>
          <dd>
            <code>{settings.failure.reason}</code>
          </dd>
        </dl>
      )}
      {settings.lastDelivery && (
        <p className="muted">
          {t.emailLastDeliveryLabel}:{" "}
          {settings.lastDelivery.outcome === "delivered"
            ? t.emailLastDeliveryDelivered
            : t.emailLastDeliveryFailed}{" "}
          · {settings.lastDelivery.recipient} ·{" "}
          {formatObservedAt(settings.lastDelivery.attemptedAt, lang)}
        </p>
      )}
    </div>
  );
}

export function EmailSettingsForm({
  lang,
  settings,
  saveAction,
  diagnosticAction,
}: {
  lang: Lang;
  settings: MailSettingsView;
  saveAction: EmailSettingsAction;
  diagnosticAction: EmailSettingsAction;
}) {
  const t = dictionaries[lang];
  const router = useRouter();
  const [saveState, saveFormAction, saving] = useActionState(saveAction, INITIAL);
  const [sendState, sendFormAction, sending] = useActionState(diagnosticAction, INITIAL);

  // A successful save or send changes the status panel, which the server
  // renders; refresh keeps that panel and the stored settings in step.
  useEffect(() => {
    if (saveState.tone === "success" && saveState.message) router.refresh();
  }, [saveState, router]);
  useEffect(() => {
    if (sendState.tone === "success" && sendState.message) router.refresh();
  }, [sendState, router]);

  const notice = (state: EmailSettingsState) =>
    state.message ? (
      <div
        className={`notice notice-${state.tone === "error" ? "error" : "info"}`}
        role={state.tone === "error" ? "alert" : "status"}
      >
        {state.message}
      </div>
    ) : null;

  return (
    <>
      <StatusPanel settings={settings} lang={lang} />

      <section className="panel" aria-labelledby="email-settings-heading">
        <h3 id="email-settings-heading" style={{ marginTop: 0 }}>
          {t.emailSettingsTitle}
        </h3>
        <p className="muted">{t.emailSettingsIntro}</p>

        {notice(saveState)}

        <form action={saveFormAction} aria-describedby="email-settings-hint">
          <input type="hidden" name="lang" value={lang} />
          <div className="field-grid">
            <div className="field">
              <label htmlFor="host">{t.smtpHostLabel}</label>
              <input
                id="host"
                name="host"
                type="text"
                defaultValue={settings.smtp?.host ?? ""}
                autoComplete="off"
                required
              />
              <span className="hint">{t.smtpHostHint}</span>
            </div>
            <div className="field">
              <label htmlFor="port">{t.smtpPortLabel}</label>
              <input
                id="port"
                name="port"
                type="number"
                min={1}
                max={65535}
                defaultValue={settings.smtp?.port ?? 587}
                required
              />
              <span className="hint">{t.smtpPortHint}</span>
            </div>
            <div className="field">
              <label htmlFor="username">{t.smtpUsernameLabel}</label>
              <input
                id="username"
                name="username"
                type="text"
                defaultValue={settings.smtp?.username ?? ""}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="password">{t.smtpPasswordLabel}</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
              />
              <span className="hint">
                {settings.smtp?.passwordSet ? t.smtpPasswordStored : t.smtpPasswordMissing}{" "}
                {t.smtpPasswordKeepHint}
              </span>
            </div>
            <div className="field">
              <label htmlFor="fromAddress">{t.smtpFromAddressLabel}</label>
              <input
                id="fromAddress"
                name="fromAddress"
                type="email"
                defaultValue={settings.smtp?.fromAddress ?? ""}
                required
              />
              <span className="hint">{t.smtpFromAddressHint}</span>
            </div>
            <div className="field">
              <label htmlFor="fromName">{t.smtpFromNameLabel}</label>
              <input
                id="fromName"
                name="fromName"
                type="text"
                defaultValue={settings.smtp?.fromName ?? ""}
              />
            </div>
            <div className="field">
              <label htmlFor="recipient">{t.smtpDiagnosticRecipientLabel}</label>
              <input
                id="recipient"
                name="recipient"
                type="email"
                defaultValue={settings.recipient ?? ""}
              />
              <span className="hint">{t.smtpDiagnosticRecipientHint}</span>
            </div>
            <label className="field field-check" htmlFor="secure">
              <span>
                <input
                  id="secure"
                  name="secure"
                  type="checkbox"
                  defaultChecked={settings.smtp?.secure ?? false}
                />{" "}
                {t.smtpSecureLabel}
              </span>
            </label>
          </div>
          <button className="btn-submit" type="submit" disabled={saving}>
            {saving ? t.emailSaving : t.emailSave}
          </button>
        </form>
      </section>

      <section className="panel" aria-labelledby="email-diagnostic-heading">
        <h3 id="email-diagnostic-heading" style={{ marginTop: 0 }}>
          {t.emailDiagnosticTitle}
        </h3>
        <p className="muted">{t.emailDiagnosticIntro}</p>
        {notice(sendState)}
        <form action={sendFormAction}>
          <input type="hidden" name="lang" value={lang} />
          <button
            className="btn-primary"
            type="submit"
            disabled={sending || !settings.configured}
          >
            {sending ? t.emailDiagnosticSending : t.emailDiagnosticSend}
          </button>
        </form>
      </section>
    </>
  );
}
