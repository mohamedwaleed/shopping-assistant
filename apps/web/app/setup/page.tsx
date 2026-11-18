// SPDX-License-Identifier: AGPL-3.0-or-later
import { getCore } from "@/lib/core";
import { dictionaries, resolveLang } from "@/lib/i18n";
import { Notice, SetupForm } from "@/app/auth-forms";
import { claimSetupAction } from "@/app/actions";

export const dynamic = "force-dynamic";

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];

  const state = await getCore().auth.getSetupState();
  if (!state.ok) {
    return (
      <Notice
        lang={lang}
        title={t.setupUnavailableTitle}
        body={t.setupUnavailableBody}
        tone="error"
      />
    );
  }
  if (state.value.complete) {
    return <Notice lang={lang} title={t.setupCompleteTitle} body={t.setupCompleteBody} />;
  }
  if (!state.value.claimable) {
    return (
      <Notice
        lang={lang}
        title={t.setupUnavailableTitle}
        body={t.setupUnavailableBody}
        tone="error"
      />
    );
  }

  return <SetupForm lang={lang} action={claimSetupAction} />;
}
