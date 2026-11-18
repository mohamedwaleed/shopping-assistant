// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCore, getDb } from "@/lib/core";
import { getAuth, closeAuth, requestIdentity } from "@/lib/auth/session";
import { createAccountProvisioner } from "@/lib/auth/provisioner";
import { applySetCookies } from "@/lib/auth/cookies";
import { authErrorMessage } from "@/lib/auth/messages";
import { dictionaries, resolveLang } from "@/lib/i18n";
import type { AuthFormState } from "@/app/auth-forms";

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
      sessionEstablished: true,
    },
    {
      ...provisioner,
      verifyCredentials: async (input) => {
        const verified = await provisioner.verifyCredentials(input);
        if (!verified) return null;
        const signIn = await auth.api.signInEmail({
          body: { email: input.email, password: input.password },
          returnHeaders: true,
        });
        await applySetCookies(signIn.headers);
        return verified;
      },
    },
  );

  if (!result.ok) return { error: authErrorMessage(result.error, t) };
  redirect(`/?lang=${lang}`);
}

export async function signOutAction(): Promise<void> {
  const identity = await requestIdentity();
  if (identity) {
    await getDb()("session").where({ id: identity.sessionId }).delete();
    await getCore().auth.signOut({ sessionRevoked: true });
  }
  const store = await cookies();
  for (const name of [
    "better-auth.session_token",
    "__Secure-better-auth.session_token",
    "better-auth.session_data",
    "__Secure-better-auth.session_data",
  ]) {
    store.delete(name);
  }
  closeAuth();
  redirect("/sign-in");
}
