// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { redirect } from "next/navigation";
import { nodemailerTransport } from "@shopping/core/mail-transport";
import { cookies, headers } from "next/headers";
import { getCore, getDb } from "@/lib/core";
import { getAuth, closeAuth, requestIdentity } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { createCredentialChanger, createPasswordRecovery } from "@/lib/auth/credentials";
import { applySetCookies, SESSION_COOKIE_NAMES } from "@/lib/auth/cookies";
import { accountErrorMessage, authErrorMessage, emailErrorMessage } from "@/lib/auth/messages";
import { linkBaseUrl } from "@/lib/email-link-request";
import { dictionaries, resolveLang } from "@/lib/i18n";
import type { AccountFormState, AuthFormState } from "@/app/auth-forms";
import type { LinkFormState } from "@/app/email-link-forms";
import type { TwoFactorFormState } from "@/app/auth-forms";
import type { EmailSettingsState } from "@/app/administration/email/email-form";

function text(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Server actions for the setup and sign-in screens. Authorization and
 * admission stay in core; this only moves form values and session cookies.
 */
export async function claimSetupAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const auth = getAuth();
  const provisioner = createAccountProvisioner(auth, getDb());

  const result = await getCore().auth.claimSetup(
    {
      token: text(formData, "token"),
      name: text(formData, "name"),
      email: text(formData, "email"),
      password: text(formData, "password"),
      workspaceName: text(formData, "workspaceName"),
      sessionEstablished: true,
    },
    {
      ...provisioner,
      createCredentialAccount: async (input) => {
        const created = await provisioner.createCredentialAccount(input);
        const signIn = await auth.api.signInEmail({
          body: { email: input.email, password: input.password },
          returnHeaders: true,
        });
        await applySetCookies(signIn.headers);
        return created;
      },
    },
  );

  if (!result.ok) return { error: authErrorMessage(result.error, t) };
  redirect(`/?lang=${lang}`);
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const auth = getAuth();
  const provisioner = createAccountProvisioner(auth, getDb());

  const result = await getCore().auth.signIn(
    {
      email: text(formData, "email"),
      password: text(formData, "password"),
      secondFactorCode: text(formData, "secondFactorCode"),
      sessionEstablished: true,
    },
    provisioner,
  );

  if (!result.ok) return { error: authErrorMessage(result.error, t) };
  const signIn = await auth.api.signInEmail({ body: { email: text(formData, "email"), password: text(formData, "password") }, returnHeaders: true });
  await applySetCookies(signIn.headers);
  redirect(`/?lang=${lang}`);
}

export async function signOutAction(): Promise<void> {
  const identity = await requestIdentity();
  if (identity) {
    await getCore().auth.revokeSession(identity.trusted.principal, {
      sessionId: identity.sessionId,
    });
  }
  const store = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    store.delete(name);
  }
  closeAuth();
  redirect("/sign-in");
}

/** Sign out one listed device; the stored session is deleted, not the cookie. */
export async function revokeDeviceAction(formData: FormData): Promise<void> {
  const identity = await requestIdentity();
  if (identity) {
    await getCore().auth.revokeSession(identity.trusted.principal, {
      sessionId: text(formData, "sessionId"),
    });
  }
  redirect(`/account?lang=${resolveLang(text(formData, "lang"))}`);
}

/** Sign out every device of this account, including this one. */
export async function revokeAllDevicesAction(formData: FormData): Promise<void> {
  const identity = await requestIdentity();
  if (identity) {
    await getCore().auth.revokeAllSessions(identity.trusted.principal);
  }
  const store = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    store.delete(name);
  }
  closeAuth();
  redirect(`/sign-in?lang=${resolveLang(text(formData, "lang"))}`);
}

/**
 * Change the password after recent authentication. Core owns the recent-auth
 * gate and validation; the identity library verifies the current password.
 */
export async function changePasswordAction(
  _previous: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];
  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const auth = getAuth();
  const requestHeaders = await headers();
  // The library re-reads the caller's session cookie before it changes
  // anything, so a revoked session cannot complete the change.
  const result = await getCore().auth.changePassword(
    identity.trusted.principal,
    {
      currentPassword: text(formData, "currentPassword"),
      newPassword: text(formData, "newPassword"),
    },
    createCredentialChanger(auth, getDb(), {
      cookie: requestHeaders.get("cookie"),
    }),
  );

  if (!result.ok) return { error: accountErrorMessage(result.error, t) };
  return { error: null, notice: t.passwordChangedNotice };
}

/** Begin authenticator enrollment; the core enforces a recent session. */
export async function beginTwoFactorEnrollmentAction(
  _previous: TwoFactorFormState,
  formData: FormData,
): Promise<TwoFactorFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const identity = await requestIdentity();
  if (!identity) return { error: dictionaries[lang].accountSessionsExpired };
  const result = await getCore().auth.beginTwoFactorEnrollment(identity.trusted.principal);
  if (!result.ok) return { error: accountErrorMessage(result.error, dictionaries[lang]) };
  return { error: null, secret: result.value.secret };
}

/** Confirm the code and display each generated recovery code exactly once. */
export async function confirmTwoFactorEnrollmentAction(
  _previous: TwoFactorFormState,
  formData: FormData,
): Promise<TwoFactorFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const identity = await requestIdentity();
  if (!identity) return { error: dictionaries[lang].accountSessionsExpired };
  const result = await getCore().auth.confirmTwoFactorEnrollment(identity.trusted.principal, { code: text(formData, "code") });
  if (!result.ok) return { error: accountErrorMessage(result.error, dictionaries[lang]) };
  return { error: null, recoveryCodes: result.value.recoveryCodes };
}

export async function saveEmailSettingsAction(
  _previous: EmailSettingsState,
  formData: FormData,
): Promise<EmailSettingsState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const identity = await requestIdentity();
  if (!identity) return { tone: "error", message: t.emailAdministratorsOnly };

  const port = Number(text(formData, "port"));
  const result = await getCore().mail.saveSettings(identity.trusted.principal, {
    host: text(formData, "host"),
    port: Number.isFinite(port) ? port : 0,
    secure: text(formData, "secure") === "on",
    username: text(formData, "username"),
    password: text(formData, "password") || undefined,
    fromAddress: text(formData, "fromAddress"),
    fromName: text(formData, "fromName"),
    recipient: text(formData, "recipient"),
  });
  if (!result.ok) return { tone: "error", message: emailErrorMessage(result.error, t) };
  return { tone: "success", message: t.emailSaved };
}

export async function sendDiagnosticAction(
  _previous: EmailSettingsState,
  formData: FormData,
): Promise<EmailSettingsState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const identity = await requestIdentity();
  if (!identity) return { tone: "error", message: t.emailAdministratorsOnly };

  const result = await getCore().mail.sendDiagnostic(
    identity.trusted.principal,
    nodemailerTransport(),
  );
  if (!result.ok) return { tone: "error", message: emailErrorMessage(result.error, t) };
  return { tone: "success", message: t.emailDiagnosticSent };
}

/**
 * The origin the browser used to reach this installation. Delivered links are
 * built from it, so a self-hosted deployment behind a proxy still points the
 * recipient at the address they are already using.
 */
async function requestOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  if (!host) return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const forwarded = requestHeaders.get("x-forwarded-proto");
  return `${forwarded ?? "http"}://${host}`;
}

/**
 * Accept an invitation: the token and the invited address come from the link,
 * the shopper adds a name, password and workspace name. Core spends the token
 * and provisions the identity; the shopper is then signed in so the account
 * screen works straight away, which needs the session written as a cookie.
 */
export async function acceptInvitationAction(
  _previous: LinkFormState,
  formData: FormData,
): Promise<LinkFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const email = text(formData, "email");
  const password = text(formData, "password");
  const auth = getAuth();
  const result = await getCore().emailLinks.acceptInvitation(
    {
      email,
      token: text(formData, "token"),
      name: text(formData, "name"),
      password,
      workspaceName: text(formData, "workspaceName"),
    },
    createAccountProvisioner(auth, getDb()),
  );
  if (!result.ok) {
    // An expired or already-spent link is not a form mistake: say so plainly.
    if (result.error.kind === "invalid-email-link") return { error: t.invitationInvalidBody };
    return { error: authErrorMessage(result.error, t) };
  }

  // The account exists and the token is spent; a failure to sign in here must
  // not read as a failed acceptance, so the screen still confirms the result.
  try {
    const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    await applySetCookies(signIn.headers);
  } catch {
    // The shopper can sign in with the password they just chose.
  }
  return { error: null, done: true };
}

/** Step one of recovery. Unknown addresses answer exactly like known ones. */
export async function requestPasswordResetAction(
  _previous: LinkFormState,
  formData: FormData,
): Promise<LinkFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const result = await getCore().emailLinks.requestPasswordReset(
    { email: text(formData, "email"), linkBaseUrl: linkBaseUrl("password-reset", await requestOrigin()) },
    nodemailerTransport(),
  );
  // A delivery problem describes this installation's mail server, never
  // whether the address has an account, so it is safe to report.
  if (!result.ok) return { error: emailErrorMessage(result.error, t) };
  return { error: null, notice: t.resetRequestSentBody };
}

/**
 * Step two of recovery. Core spends the token atomically, so a replay or a
 * concurrent submission loses the race and is told the link is unusable; a
 * completed reset deletes every stored session of the account, and the browser
 * is told to drop the session cookies it may still hold.
 */
export async function completePasswordResetAction(
  _previous: LinkFormState,
  formData: FormData,
): Promise<LinkFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const result = await getCore().emailLinks.resetPassword(
    { email: text(formData, "email"), token: text(formData, "token"), newPassword: text(formData, "password") },
    createPasswordRecovery(getAuth(), getDb()),
  );
  if (!result.ok) {
    if (result.error.kind === "second-factor-required") return { error: t.resetBlockedBySecondFactorBody };
    if (result.error.kind === "invalid-email-link") return { error: t.resetLinkInvalidBody };
    return { error: authErrorMessage(result.error, t) };
  }

  // Every session is gone in storage; clearing the cookies keeps the browser
  // from replaying one and landing on a page that cannot admit it.
  const store = await cookies();
  for (const name of SESSION_COOKIE_NAMES) store.delete(name);
  closeAuth();
  return { error: null, done: true };
}

/**
 * Start an email-address change from the account screen. Core keeps the
 * recent-authentication requirement and the authenticator check, and only
 * delivers a link; the sign-in address moves when that link is opened.
 */
export async function requestEmailChangeAction(
  _previous: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];
  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const result = await getCore().emailLinks.requestEmailChange(
    identity.trusted.principal,
    {
      newEmail: text(formData, "newEmail"),
      secondFactorCode: text(formData, "secondFactorCode"),
      linkBaseUrl: linkBaseUrl("email-change", await requestOrigin()),
    },
    nodemailerTransport(),
  );
  if (!result.ok) return { error: accountErrorMessage(result.error, t) };
  return { error: null, notice: t.emailChangeSent };
}

/**
 * Complete the change from the link delivered to the new mailbox. The token
 * carries the account it belongs to, so this needs no session: the recipient
 * proves ownership of the new address by opening the message.
 */
export async function confirmEmailChangeAction(
  _previous: LinkFormState,
  formData: FormData,
): Promise<LinkFormState> {
  const lang = resolveLang(text(formData, "lang"));
  const t = dictionaries[lang];

  const result = await getCore().emailLinks.confirmEmailChange({
    email: text(formData, "email"),
    token: text(formData, "token"),
  });
  if (!result.ok) return { error: t.confirmEmailInvalidBody };
  return { error: null, done: true };
}
