// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";
import { AcceptInvitationForm, Notice } from "@/app/auth-forms";
import { acceptInvitationAction } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * The invitation link's landing page. The token names the invited address, so
 * the form never asks for one: the account is created for that mailbox only.
 */
export default async function AcceptInvitationPage({
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
        title={t.invitationTitle}
        body={t.invitationMissingToken}
        tone="error"
      />
    );
  }

  return <AcceptInvitationForm lang={lang} action={acceptInvitationAction} token={token} />;
}
