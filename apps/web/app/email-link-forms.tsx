// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shared frame and the forms of the three email-link flows: accepting an
 * invitation, recovering a password and changing the sign-in address. Every
 * screen here is reached from a link or a signed-in account form, never from
 * public navigation, and every one submits through the core through a server
 * action — the components only render fields and show the outcome.
 */
"use client";

import { useActionState } from "react";
import type { AccountFormAction } from "@/app/auth-forms";
import type { Lang } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n";

function LanguageSwitch({ lang }: { lang: Lang }) {
  const other: Lang = lang === "en" ? "nl" : "en";
  return (
    <a className="lang-switch" href={`?lang=${other}`}>
      {dictionaries[lang].languageSwitch}
    </a>
  );
}

/** Brand, language switch and the centring shell every signed-out screen uses. */
export function AuthShell({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{dictionaries[lang].appName}</span>
        <LanguageSwitch lang={lang} />
      </div>
      {children}
    </div>
  );
}

/** What a link form reports back: an error, a finished flow, or a notice. */
export interface LinkFormState {
  error: string | null;
  /** The link was accepted and the flow is finished. */
  done?: boolean;
  /** A neutral outcome shown instead of the form, e.g. "check your email". */
  notice?: string;
}

export type LinkFormAction = (
  state: LinkFormState,
  formData: FormData,
) => Promise<LinkFormState>;

/** The address a link was delivered to and its one-time token. */
export interface LinkFields {
  email: string;
  token: string;
}

/**
 * A dead link is not a sign-in problem: the recipient may already be signed in
 * or never had an account. The only way forward is a new link, so the card says
 * what failed and offers the action that produces another one.
 */
export function LinkProblem({
  lang,
  title,
  body,
  action,
}: {
  lang: Lang;
  title: string;
  body: string;
  action: { label: string; href: string };
}) {
  return (
    <AuthShell lang={lang}>
      <section className="auth-card" aria-labelledby="link-problem-title">
        <h1 id="link-problem-title">{title}</h1>
        <div className="notice notice-error" role="alert">
          {body}
        </div>
        <a className="btn-submit btn-link" href={action.href}>
          {action.label}
        </a>
      </section>
    </AuthShell>
  );
}

/**
 * The invitation link is the only way in: the invited address is bound to the
 * token, so it is shown read-only. Once the token is spent the form gives way to
 * a confirmation, because the same link cannot be used twice.
 */
export function AcceptInvitationForm({
  lang,
  link,
  action,
}: {
  lang: Lang;
  link: LinkFields;
  action: LinkFormAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  if (state.done) {
    return (
      <AuthShell lang={lang}>
        <section className="auth-card" aria-labelledby="invitation-done-title">
          <h1 id="invitation-done-title">{t.acceptInvitationDoneTitle}</h1>
          <div className="notice notice-info" role="status">
            {t.acceptInvitationDoneBody}
          </div>
          <a className="btn-submit btn-link" href={`/sign-in?lang=${lang}`}>
            {t.signInSubmit}
          </a>
        </section>
      </AuthShell>
    );
  }

  return (
    <AuthShell lang={lang}>
      <form className="auth-card" action={formAction} aria-labelledby="accept-invitation-title">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="token" value={link.token} />
        <h1 id="accept-invitation-title">{t.acceptInvitationTitle}</h1>
        <p className="lede">{t.acceptInvitationIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="invitation-email">{t.emailLabel}</label>
          <input id="invitation-email" name="email" type="email" value={link.email} readOnly required />
          <span className="hint">{t.invitationTokenHint}</span>
        </div>

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

        <div className="field">
          <label htmlFor="invitation-workspace">{t.workspaceNameLabel}</label>
          <input id="invitation-workspace" name="workspaceName" type="text" required />
          <span className="hint">{t.workspaceNameHint}</span>
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.acceptInvitationWorking : t.acceptInvitationSubmit}
        </button>
        <p className="auth-note">{t.acceptInvitationNote}</p>
      </form>
    </AuthShell>
  );
}

/** Step one of recovery: ask for a link, answered without revealing accounts. */
export function ResetRequestForm({ lang, action }: { lang: Lang; action: LinkFormAction }) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  if (state.notice) {
    return (
      <AuthShell lang={lang}>
        <section className="auth-card" aria-labelledby="reset-sent-title">
          <h1 id="reset-sent-title">{t.resetRequestSentTitle}</h1>
          <div className="notice notice-info" role="status">
            {state.notice}
          </div>
          <a className="btn-submit btn-link" href={`/sign-in?lang=${lang}`}>
            {t.signInSubmit}
          </a>
        </section>
      </AuthShell>
    );
  }

  return (
    <AuthShell lang={lang}>
      <form className="auth-card" action={formAction} aria-labelledby="reset-request-title">
        <input type="hidden" name="lang" value={lang} />
        <h1 id="reset-request-title">{t.resetRequestTitle}</h1>
        <p className="lede">{t.resetRequestIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="reset-email">{t.emailLabel}</label>
          <input id="reset-email" name="email" type="email" autoComplete="email" required />
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.resetRequestWorking : t.resetRequestSubmit}
        </button>
        <p className="auth-note">{t.resetRequestNote}</p>
      </form>
    </AuthShell>
  );
}

/** Step two of recovery: the link's token and address, plus the new password. */
export function ResetPasswordForm({
  lang,
  link,
  action,
  requestHref,
  requestLabel,
}: {
  lang: Lang;
  link: LinkFields;
  action: LinkFormAction;
  requestHref: string;
  requestLabel: string;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  if (state.done) {
    return (
      <AuthShell lang={lang}>
        <section className="auth-card" aria-labelledby="reset-done-title">
          <h1 id="reset-done-title">{t.resetCompleteDoneTitle}</h1>
          <div className="notice notice-info" role="status">
            {t.resetCompleteDoneBody}
          </div>
          <a className="btn-submit btn-link" href={`/sign-in?lang=${lang}`}>
            {t.signInSubmit}
          </a>
        </section>
      </AuthShell>
    );
  }

  return (
    <AuthShell lang={lang}>
      <form className="auth-card" action={formAction} aria-labelledby="reset-complete-title">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="token" value={link.token} />
        <input type="hidden" name="email" value={link.email} />
        <h1 id="reset-complete-title">{t.resetCompleteTitle}</h1>
        <p className="lede">{t.resetCompleteIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="reset-account">{t.emailLabel}</label>
          <input id="reset-account" type="email" value={link.email} readOnly />
        </div>

        <div className="field">
          <label htmlFor="reset-new-password">{t.newPasswordLabel}</label>
          <input
            id="reset-new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={10}
            required
          />
          <span className="hint">{t.passwordHint}</span>
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.resetCompleteWorking : t.resetCompleteSubmit}
        </button>
        <p className="auth-note">
          <a href={requestHref}>{requestLabel}</a>
        </p>
      </form>
    </AuthShell>
  );
}

/** The account screen's email-address change: it sends a link, not an edit. */
export function EmailChangeForm({
  lang,
  currentEmail,
  action,
}: {
  lang: Lang;
  currentEmail: string;
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
        <label htmlFor="current-email">{t.emailChangeCurrentLabel}</label>
        <input id="current-email" type="email" value={currentEmail} readOnly />
      </div>

      <div className="field">
        <label htmlFor="new-email">{t.emailChangeNewLabel}</label>
        <input id="new-email" name="newEmail" type="email" autoComplete="email" required />
      </div>

      <div className="field">
        <label htmlFor="email-second-factor">{t.emailChangeSecondFactorLabel}</label>
        <input
          id="email-second-factor"
          name="secondFactorCode"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
        />
      </div>

      <button className="btn-submit" type="submit" disabled={pending}>
        {pending ? t.emailChangeWorking : t.emailChangeSubmit}
      </button>
      <p className="auth-note">
        {t.emailChangeRecentHint} {t.emailChangeNoAddressHint}
      </p>
    </form>
  );
}

/** The address the confirmation link was delivered to, plus its token. */
export function ConfirmEmailForm({
  lang,
  link,
  action,
}: {
  lang: Lang;
  link: LinkFields;
  action: LinkFormAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  if (state.done) {
    return (
      <AuthShell lang={lang}>
        <section className="auth-card" aria-labelledby="confirm-email-done-title">
          <h1 id="confirm-email-done-title">{t.confirmEmailDoneTitle}</h1>
          <div className="notice notice-info" role="status">
            {t.confirmEmailDoneBody}
          </div>
          <a className="btn-submit btn-link" href={`/sign-in?lang=${lang}`}>
            {t.signInSubmit}
          </a>
        </section>
      </AuthShell>
    );
  }

  return (
    <AuthShell lang={lang}>
      <form className="auth-card" action={formAction} aria-labelledby="confirm-email-title">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="token" value={link.token} />
        <input type="hidden" name="email" value={link.email} />
        <h1 id="confirm-email-title">{t.confirmEmailTitle}</h1>
        <p className="lede">{t.confirmEmailIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <div className="field">
          <label htmlFor="confirm-email-address">{t.emailChangeNewLabel}</label>
          <input id="confirm-email-address" type="email" value={link.email} readOnly />
        </div>

        <button className="btn-submit" type="submit" disabled={pending}>
          {pending ? t.confirmEmailWorking : t.confirmEmailSubmit}
        </button>
      </form>
    </AuthShell>
  );
}
