// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { dictionaries, resolveLang } from "@/lib/i18n";
import {
  changePasswordAction,
  beginTwoFactorEnrollmentAction,
  confirmTwoFactorEnrollmentAction,
  revokeAllDevicesAction,
  revokeDeviceAction,
} from "@/app/actions";
import { DeviceList, PasswordForm, TwoFactorForm } from "@/app/auth-forms";

/**
 * Account settings: the signed-in devices of this account and the password
 * change form. Devices come from stored sessions through the core, so the list
 * shows exactly what a revoke would delete, and nothing about another account.
 */
export default async function Account({
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

  const devices = await getCore().auth.listSessions(identity.trusted.principal);
  const sessions = devices.ok ? devices.value.sessions : [];

  return (
    <div className="app-shell" lang={lang}>
      <nav className="rail" aria-label="Main">
        <span className="brand">{t.appName}</span>
        <a className="nav-item" href={`/?lang=${lang}`}>
          {t.navProducts}
        </a>
        <span className="nav-item active">{t.accountTitle}</span>
      </nav>

      <main className="content">
        <div className="topbar">
          <h1>{t.accountTitle}</h1>
          <a className="lang-switch" href={`/account?lang=${otherLang}`}>
            {t.languageSwitch}
          </a>
        </div>
        <p className="muted">{t.accountIntro}</p>

        <DeviceList
          lang={lang}
          devices={sessions}
          revokeAction={revokeDeviceAction}
          revokeAllAction={revokeAllDevicesAction}
        />
        <PasswordForm lang={lang} action={changePasswordAction} />
        <TwoFactorForm lang={lang} beginAction={beginTwoFactorEnrollmentAction} confirmAction={confirmTwoFactorEnrollmentAction} />
      </main>
    </div>
  );
}
