// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";
import { Notice } from "@/app/auth-forms";
import { confirmEmailChangeAction } from "@/app/actions";
import { ConfirmEmailChangeForm } from "./confirm-form";

export const dynamic = "force-dynamic";

/**
 * The confirmation link's landing page, opened in the new mailbox. Confirming
 * is what switches the sign-in identity, and it signs every device out.
 */
export default async function ConfirmEmailChangePage({
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
        title={t.emailChangeConfirmTitle}
        body={t.errorInvalidAccountLink}
        tone="error"
      />
    );
  }

  return <ConfirmEmailChangeForm lang={lang} token={token} action={confirmEmailChangeAction} />;
}
