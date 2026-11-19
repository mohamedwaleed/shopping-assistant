// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { redirect } from "next/navigation";
import { nodemailerTransport } from "@shopping/core/mail-transport";
import { cookies, headers } from "next/headers";
import { getCore, getDb } from "@/lib/core";
import { getAuth, closeAuth, requestIdentity } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { createCredentialChanger } from "@/lib/auth/credentials";
import { applySetCookies, SESSION_COOKIE_NAMES } from "@/lib/auth/cookies";
import { accountErrorMessage, authErrorMessage, emailErrorMessage } from "@/lib/auth/messages";
import { dictionaries, resolveLang } from "@/lib/i18n";
import type { AccountFormState, AuthFormState } from "@/app/auth-forms";
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
