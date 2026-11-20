// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";
import { linkFromSearchParams, type SearchParams } from "@/lib/email-link-request";
import { ConfirmEmailForm, LinkProblem } from "@/app/email-link-forms";
import { confirmEmailChangeAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * The destination of the confirmation email an address change sends to the new
 * mailbox. Opening the link and confirming spends the token in
 * `core.emailLinks.confirmEmailChange`, which moves the sign-in address and
 * marks it verified; a replay, an expired token or an address another account
 * already owns is refused there. The screen needs no session: the message in
 * the new mailbox is the proof, and starting the change itself required recent
 * authentication on the account screen.
 */
export default async function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];
  const { email, token } = linkFromSearchParams(params);

  if (!token) {
    return (
      <LinkProblem
        lang={lang}
        title={t.confirmEmailInvalidTitle}
        body={t.confirmEmailInvalidBody}
        action={{ label: t.accountTitle, href: `/account?lang=${lang}` }}
      />
    );
  }

  return (
    <ConfirmEmailForm
      lang={lang}
      link={{ email, token }}
      action={confirmEmailChangeAction}
    />
  );
}
