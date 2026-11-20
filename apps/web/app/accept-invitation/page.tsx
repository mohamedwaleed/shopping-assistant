// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";
import { linkFromSearchParams, type SearchParams } from "@/lib/email-link-request";
import { AcceptInvitationForm, LinkProblem } from "@/app/email-link-forms";
import { acceptInvitationAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * The destination of an invitation email. The link carries the invited address
 * and its one-time token; the form adds a name, password and workspace name and
 * submits through `core.emailLinks.acceptInvitation`, which spends the token
 * atomically and creates the shopper's own private workspace. A link with no
 * token cannot be honoured, and a refused token (expired, already used, or
 * bound to another address) is reported plainly by the submitted form.
 */
export default async function AcceptInvitationPage({
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
        title={t.invitationInvalidTitle}
        body={t.invitationMissingTokenBody}
        action={{ label: t.signInSubmit, href: `/sign-in?lang=${lang}` }}
      />
    );
  }

  return (
    <AcceptInvitationForm
      lang={lang}
      link={{ email, token }}
      action={acceptInvitationAction}
    />
  );
}
