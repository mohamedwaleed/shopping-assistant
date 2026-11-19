// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useActionState } from "react";
import type { Lang } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n";

export interface AuthFormState {
  error: string | null;
  notice?: string;
}

export type AuthFormAction = (
  state: AuthFormState,
  formData: FormData,
) => Promise<AuthFormState>;

export interface AccountFormState {
  error: string | null;
  notice?: string;
}

export type AccountFormAction = (
  state: AccountFormState,
  formData: FormData,
) => Promise<AccountFormState>;

function LanguageSwitch({ lang }: { lang: Lang }) {
  const other: Lang = lang === "en" ? "nl" : "en";
  return (
    <a className="lang-switch" href={`?lang=${other}`}>
      {dictionaries[lang].languageSwitch}
    </a>
  );
}

export function SetupForm({ lang, action }: { lang: Lang; action: AuthFormAction }) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{t.appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      <form className="auth-card" action={formAction} aria-labelledby="setup-title">
        <input type="hidden" name="lang" value={lang} />
        <h1 id="setup-title">{t.setupTitle}</h1>
        <p className="lede">{t.setupIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="token">{t.setupTokenLabel}</label>
          <input id="token" name="token" type="password" autoComplete="off" required />
          <span className="hint">{t.setupTokenHint}</span>
        </div>

        <div className="field">
          <label htmlFor="name">{t.nameLabel}</label>
          <input id="name" name="name" type="text" autoComplete="name" required />
        </div>

        <div className="field">
          <label htmlFor="email">{t.emailLabel}</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="field">
          <label htmlFor="password">{t.passwordLabel}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <span className="hint">{t.passwordHint}</span>
        </div>

        <div className="field">
          <label htmlFor="workspaceName">{t.workspaceNameLabel}</label>
          <input id="workspaceName" name="workspaceName" type="text" />
          <span className="hint">{t.workspaceNameHint}</span>
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.setupWorking : t.setupSubmit}
        </button>
        <p className="auth-note">{t.emailNotVerifiedNote}</p>
      </form>
    </div>
  );
}

export function SignInForm({ lang, action }: { lang: Lang; action: AuthFormAction }) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{t.appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      <form className="auth-card" action={formAction} aria-labelledby="sign-in-title">
        <input type="hidden" name="lang" value={lang} />
        <h1 id="sign-in-title">{t.signInTitle}</h1>
        <p className="lede">{t.signInIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="email">{t.emailLabel}</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="field">
          <label htmlFor="password">{t.passwordLabel}</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.signInWorking : t.signInSubmit}
        </button>
        <p className="auth-note">
          <a href={`/forgot-password?lang=${lang}`}>{t.forgotPasswordLink}</a>
        </p>
        <p className="auth-note">{t.signInNoAccount}</p>
      </form>
    </div>
  );
}

export function Notice({
  lang,
  title,
  body,
  tone = "info",
}: {
  lang: Lang;
  title: string;
  body: string;
  tone?: "info" | "error";
}) {
  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{dictionaries[lang].appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      <section className="auth-card" aria-labelledby="notice-title">
        <h1 id="notice-title">{title}</h1>
        <div className={`notice notice-${tone}`}>{body}</div>
        <a
          className="btn-submit"
          href={`/sign-in?lang=${lang}`}
          style={{ display: "block", textAlign: "center" }}
        >
          {dictionaries[lang].signInSubmit}
        </a>
      </section>
    </div>
  );
}

export function SignOutButton({
  lang,
  action,
}: {
  lang: Lang;
  action: () => Promise<void>;
}) {
  return (
    <form action={action}>
      <button className="btn-quiet" type="submit">
        {dictionaries[lang].signOut}
      </button>
    </form>
  );
}

export function PasswordForm({
  lang,
  action,
}: {
  lang: Lang;
  action: AccountFormAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form className="panel" action={formAction} aria-labelledby="password-title">
      <input type="hidden" name="lang" value={lang} />
      <h2 id="password-title">{t.passwordTitle}</h2>
      <p className="muted">{t.passwordIntro}</p>

      {state.error && (
        <div className="notice notice-error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="notice notice-info" role="status">
          {state.notice}
        </div>
      )}

      <div className="field">
        <label htmlFor="currentPassword">{t.currentPasswordLabel}</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <div className="field">
        <label htmlFor="newPassword">{t.newPasswordLabel}</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
        />
        <span className="hint">{t.passwordHint}</span>
      </div>

      <button className="btn-submit" type="submit" disabled={pending}>
        {t.passwordTitle}
      </button>
    </form>
  );
}

export function DeviceList({
  lang,
  devices,
  revokeAction,
  revokeAllAction,
}: {
  lang: Lang;
  devices: ReadonlyArray<{
    id: string;
    current: boolean;
    lastActiveAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }>;
  revokeAction: (formData: FormData) => Promise<void>;
  revokeAllAction: (formData: FormData) => Promise<void>;
}) {
  const t = dictionaries[lang];
  const format = (value: string) =>
    new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));

  return (
    <section className="panel" aria-labelledby="devices-title">
      <h2 id="devices-title">{t.devicesTitle}</h2>
      {devices.length === 0 ? (
        <p className="muted">{t.devicesEmpty}</p>
      ) : (
        devices.map((device) => (
          <div className="offer-card" key={device.id}>
            <div>
              <strong>{device.userAgent ?? t.deviceUnknownAgent}</strong>
              {device.current && <span className="badge-fixture">{t.deviceCurrent}</span>}
              <div className="price-sub">
                {t.deviceLastActive}: {format(device.lastActiveAt)}
              </div>
              <div className="price-sub">
                {t.deviceExpires}: {format(device.expiresAt)}
              </div>
              <div className="price-sub">
                {t.deviceIp}: {device.ipAddress ?? "—"}
              </div>
            </div>
            <form action={revokeAction}>
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="sessionId" value={device.id} />
              <button className="btn-quiet" type="submit">
                {t.deviceSignOut}
              </button>
            </form>
          </div>
        ))
      )}

      <form action={revokeAllAction} style={{ marginTop: 16 }}>
        <input type="hidden" name="lang" value={lang} />
        <button className="btn-quiet" type="submit">
          {t.signOutEverywhere}
        </button>
        <p className="hint">{t.signOutEverywhereHint}</p>
      </form>
    </section>
  );
}

/**
 * Ask for the new sign-in address. The address only changes after the new
 * mailbox confirms the link, so this form reports the send, never a change.
 */
export function EmailChangeForm({
  lang,
  action,
}: {
  lang: Lang;
  action: AccountFormAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form className="panel" action={formAction} aria-labelledby="email-change-title">
      <input type="hidden" name="lang" value={lang} />
      <h2 id="email-change-title">{t.emailChangeTitle}</h2>
      <p className="muted">{t.emailChangeIntro}</p>

      {state.error && (
        <div className="notice notice-error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="notice notice-info" role="status">
          {state.notice}
        </div>
      )}

      <div className="field">
        <label htmlFor="newEmail">{t.emailChangeLabel}</label>
        <input id="newEmail" name="newEmail" type="email" autoComplete="email" required />
      </div>

      <button className="btn-submit" type="submit" disabled={pending}>
        {pending ? t.emailChangeSending : t.emailChangeRequest}
      </button>
    </form>
  );
}

/** Accept an invitation: the token names the address the account is created for. */
export function AcceptInvitationForm({
  lang,
  action,
  token,
}: {
  lang: Lang;
  action: AuthFormAction;
  token: string;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{t.appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      <form className="auth-card" action={formAction} aria-labelledby="invitation-title">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="token" value={token} />
        <h1 id="invitation-title">{t.invitationTitle}</h1>
        <p className="lede">{t.invitationIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="invitation-name">{t.nameLabel}</label>
          <input id="invitation-name" name="name" type="text" autoComplete="name" required />
        </div>

        <div className="field">
          <label htmlFor="invitation-password">{t.passwordLabel}</label>
          <input
            id="invitation-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <span className="hint">{t.passwordHint}</span>
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.invitationWorking : t.invitationSubmit}
        </button>
      </form>
    </div>
  );
}

/** Choose a new password from a reset or email-change link. */
export function NewPasswordForm({
  lang,
  action,
  token,
  title,
  intro,
  submit,
}: {
  lang: Lang;
  action: AuthFormAction;
  token: string;
  title: string;
  intro: string;
  submit: string;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{t.appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      <form className="auth-card" action={formAction} aria-labelledby="new-password-title">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="token" value={token} />
        <h1 id="new-password-title">{title}</h1>
        <p className="lede">{intro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="reset-password">{t.newPasswordLabel}</label>
          <input
            id="reset-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <span className="hint">{t.passwordHint}</span>
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.passwordResetWorking : submit}
        </button>
      </form>
    </div>
  );
}

/** Ask for a reset link; the screen answers the same whatever the address is. */
export function ForgotPasswordForm({
  lang,
  action,
}: {
  lang: Lang;
  action: AuthFormAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{t.appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      <form className="auth-card" action={formAction} aria-labelledby="forgot-title">
        <input type="hidden" name="lang" value={lang} />
        <h1 id="forgot-title">{t.forgotPasswordTitle}</h1>
        <p className="lede">{t.forgotPasswordIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}
        {state.notice && (
          <div className="notice notice-info" role="status">
            {state.notice}
          </div>
        )}

        <div className="field">
          <label htmlFor="forgot-email">{t.emailLabel}</label>
          <input id="forgot-email" name="email" type="email" autoComplete="email" required />
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.forgotPasswordWorking : t.forgotPasswordSubmit}
        </button>
        <p className="auth-note">{t.forgotPasswordAdminNote}</p>
      </form>
    </div>
  );
}

/** Invite a shopper from the administration screen. */
export function InviteShopperForm({
  lang,
  action,
}: {
  lang: Lang;
  action: AccountFormAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <form className="panel" action={formAction} aria-labelledby="invite-title">
      <input type="hidden" name="lang" value={lang} />
      <h2 id="invite-title">{t.inviteTitle}</h2>
      <p className="muted">{t.inviteIntro}</p>

      {state.error && (
        <div className="notice notice-error" role="alert">
          {state.error}
        </div>
      )}
      {state.notice && (
        <div className="notice notice-info" role="status">
          {state.notice}
        </div>
      )}

      <div className="field">
        <label htmlFor="invite-name">{t.nameLabel}</label>
        <input id="invite-name" name="name" type="text" autoComplete="off" required />
      </div>

      <div className="field">
        <label htmlFor="invite-email">{t.emailLabel}</label>
        <input id="invite-email" name="email" type="email" autoComplete="off" required />
        <span className="hint">{t.inviteHint}</span>
      </div>

      <button className="btn-submit" type="submit" disabled={pending}>
        {pending ? t.inviteWorking : t.inviteSubmit}
      </button>
    </form>
  );
}
