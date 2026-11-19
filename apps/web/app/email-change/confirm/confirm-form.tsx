// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useActionState } from "react";
import type { Lang } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n";
import type { AuthFormState } from "@/app/auth-forms";

export type ConfirmAction = (
  state: AuthFormState,
  formData: FormData,
) => Promise<AuthFormState>;

/**
 * Confirming a new sign-in address needs no password: the single-use link is
 * the proof that the new mailbox is reachable, so the form only submits it.
 */
export function ConfirmEmailChangeForm({
  lang,
  token,
  action,
}: {
  lang: Lang;
  token: string;
  action: ConfirmAction;
}) {
  const t = dictionaries[lang];
  const [state, formAction, pending] = useActionState(action, { error: null });

  return (
    <div className="auth-shell" lang={lang}>
      <div className="auth-header">
        <span className="brand">{t.appName}</span>
      </div>
      <form className="auth-card" action={formAction} aria-labelledby="confirm-email-title">
        <input type="hidden" name="lang" value={lang} />
        <input type="hidden" name="token" value={token} />
        <h1 id="confirm-email-title">{t.emailChangeConfirmTitle}</h1>
        <p className="lede">{t.emailChangeConfirmIntro}</p>

        {state.error && (
          <div className="notice notice-error" role="alert">
            {state.error}
          </div>
        )}

        <button className="btn-submit" type="submit" disabled={pending}>
          {t.emailChangeConfirmSubmit}
        </button>
      </form>
    </div>
  );
}
