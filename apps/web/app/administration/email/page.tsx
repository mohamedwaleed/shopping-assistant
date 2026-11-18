// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { dictionaries, resolveLang } from "@/lib/i18n";
import { signOutAction, saveEmailSettingsAction, sendDiagnosticAction } from "@/app/actions";
import { SignOutButton } from "@/app/auth-forms";
import { EmailSettingsForm } from "@/app/administration/email/email-form";

export const dynamic = "force-dynamic";

/**
 * Protected email settings for the installation administrator. The stored SMTP
 * password is never rendered: the server-rendered settings carry a
 * `passwordSet` flag, and the password input starts empty.
 */
export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];

  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const otherLang = lang === "en" ? "nl" : "en";
  const principal = identity.trusted.principal;
  const isAdministrator = principal.kind === "administrator";

  const settings = isAdministrator ? await getCore().mail.settings(principal) : null;

  return (
    <div className="app-shell" lang={lang}>
      <nav className="rail" aria-label="Main">
        <span className="brand">{t.appName}</span>
        <a className="nav-item" href={`/?lang=${lang}`}>
          {t.navProducts}
        </a>
        <span className="nav-item active">{t.navAdministration}</span>
        <div className="rail-footer">
          <div className="rail-user">
            <strong>{identity.trusted.user.name}</strong>
            {identity.trusted.user.email}
          </div>
          <SignOutButton lang={lang} action={signOutAction} />
        </div>
      </nav>

      <main className="content">
        <div className="topbar">
          <h1>{t.emailSettingsTitle}</h1>
          <a className="lang-switch" href={`/administration/email?lang=${otherLang}`}>
            {t.languageSwitch}
          </a>
        </div>

        {!settings || !settings.ok ? (
          <div className="notice notice-error" role="alert">
            {t.emailAdministratorsOnly}
          </div>
        ) : (
          <>
            <p className="muted">{t.emailAdminOnlyNote}</p>
            <EmailSettingsForm
              lang={lang}
              settings={settings.value}
              saveAction={saveEmailSettingsAction}
              diagnosticAction={sendDiagnosticAction}
            />
          </>
        )}
      </main>
    </div>
  );
}
