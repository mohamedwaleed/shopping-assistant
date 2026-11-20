// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";
import { linkFromSearchParams, type SearchParams } from "@/lib/email-link-request";
import { ResetPasswordForm, ResetRequestForm } from "@/app/email-link-forms";
import { completePasswordResetAction, requestPasswordResetAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * Password recovery in one route, because the delivered link and the request
 * form share it: a link arrives as `/reset-password?email=…&token=…`, and
 * `/reset-password` alone asks for one. The completion form submits through
 * `core.emailLinks.resetPassword`, which spends the token atomically — an
 * expired, replayed or concurrently used token is refused there — and revokes
 * every stored session of the account when it succeeds.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];
  const { email, token } = linkFromSearchParams(params);

  if (!token) return <ResetRequestForm lang={lang} action={requestPasswordResetAction} />;

  return (
    <ResetPasswordForm
      lang={lang}
      link={{ email, token }}
      action={completePasswordResetAction}
      requestHref={`/reset-password?lang=${lang}`}
      requestLabel={t.requestNewResetLink}
    />
  );
}
