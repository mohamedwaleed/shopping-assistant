// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";
import { NewPasswordForm, Notice } from "@/app/auth-forms";
import { resetPasswordAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * The reset link's landing page. The token stays in the form and is spent by
 * the action, so a reload of this page cannot consume the link before the
 * shopper has chosen a password.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];
  const token = typeof params.token === "string" ? params.token : "";

  if (!token) {
    return (
      <Notice
        lang={lang}
        title={t.passwordResetTitle}
        body={t.errorInvalidAccountLink}
        tone="error"
      />
    );
  }

  return (
    <NewPasswordForm
      lang={lang}
      action={resetPasswordAction}
      token={token}
      title={t.passwordResetTitle}
      intro={t.passwordResetIntro}
      submit={t.passwordResetSubmit}
    />
  );
}
