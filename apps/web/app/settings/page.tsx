// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import { createSecretCipher, type ModelConfigurationViewResult } from "@shopping/core";
import { getCore } from "@/lib/core";
import { dictionaries, resolveLang } from "@/lib/i18n";
import { requestIdentity } from "@/lib/auth/session";
import { signOutAction } from "@/app/actions";
import { SignOutButton } from "@/app/auth-forms";
import { ModelSettingsForm } from "@/app/model-settings";

const EMPTY_VIEW: ModelConfigurationViewResult = {
  installation: { defaultModel: null, extractionModel: null, usageSource: null, credential: null },
  workspace: null,
  effective: null,
  capability: null,
  diagnostics: { bounds: { maxCalls: 4, maxOutputTokens: 64 }, limits: { maxCalls: 8, maxOutputTokens: 512 } },
};

export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];
  const otherLang = lang === "en" ? "nl" : "en";

  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const principal = identity.trusted.principal;
  const isAdministrator = principal.kind === "administrator";

  // The installation secret is configuration, not code: without it the
  // section explains the missing prerequisite instead of failing the page.
  let view: ModelConfigurationViewResult = EMPTY_VIEW;
  let available = true;
  try {
    createSecretCipher({ key: process.env.INSTALLATION_SECRET ?? "" });
    const result = await getCore().models.read(principal);
    if (result.ok) view = result.value;
  } catch {
    available = false;
  }

  const roleLabel =
    identity.trusted.user.workspace.role === "owner" ? t.roleOwner : t.roleMember;

  return (
    <div className="app-shell" lang={lang}>
      <nav className="rail" aria-label="Main">
        <span className="brand">{t.appName}</span>
        <a className="nav-item" href={`/?lang=${lang}`}>
          {t.navProducts}
        </a>
        <a className="nav-item" href={`/settings?lang=${lang}`}>
          {t.navSettings}
        </a>
        <span className="nav-item active">{t.modelsTitle}</span>
        <div className="rail-footer">
          <div className="rail-user">
            <strong>{identity.trusted.user.name}</strong>
            {identity.trusted.user.email}
            <br />
            {t.workspaceLabel} · {roleLabel}
            {isAdministrator ? ` · ${t.administratorRole}` : ""}
          </div>
          <SignOutButton lang={lang} action={signOutAction} />
        </div>
      </nav>

      <main className="content">
        <div className="topbar">
          <h1>{t.navSettings}</h1>
          <a className="lang-switch" href={`/settings?lang=${otherLang}`}>
            {t.languageSwitch}
          </a>
        </div>

        {available ? (
          <ModelSettingsForm
            lang={lang}
            canManage={isAdministrator}
            view={view}
            bounds={view.diagnostics.bounds}
          />
        ) : (
          <div className="error-panel" role="alert">
            {t.modelsSectionUnavailable}
          </div>
        )}
      </main>
    </div>
  );
}
