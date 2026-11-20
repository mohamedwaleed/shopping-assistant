// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Lang } from "@/lib/i18n";
import { dictionaries } from "@/lib/i18n";
import { signOutAction } from "@/app/actions";
import { SignOutButton } from "@/app/auth-forms";

/**
 * The Studio rail. It is rendered from the server so navigation stays a plain
 * link list: the product search and the detail page share it without shipping
 * account state to the client.
 */
export interface ShellIdentity {
  name: string;
  email: string;
  role: "owner" | "member";
  isAdministrator: boolean;
}

export function StudioShell({
  lang,
  identity,
  active,
  children,
}: {
  lang: Lang;
  identity: ShellIdentity;
  active: "products" | "chat";
  children: React.ReactNode;
}) {
  const t = dictionaries[lang];
  const roleLabel = identity.role === "owner" ? t.roleOwner : t.roleMember;
  return (
    <div className="app-shell" lang={lang}>
      <nav className="rail" aria-label="Main">
        <a className="brand" href={`/?lang=${lang}`}>
          {t.appName}
        </a>
        <a className={`nav-item${active === "chat" ? " active" : ""}`} href={`/chat?lang=${lang}`}>
          {t.navChat}
        </a>
        <a className={`nav-item${active === "products" ? " active" : ""}`} href={`/?lang=${lang}`}>
          {t.navProducts}
        </a>
        <span className="nav-item">
          {t.navCompare}
          <span className="nav-badge">{t.navComingSoon}</span>
        </span>
        <span className="nav-item">
          {t.navWatches}
          <span className="nav-badge">{t.navComingSoon}</span>
        </span>
        <a className="nav-item" href={`/settings?lang=${lang}`}>
          {t.navSettings}
        </a>
        <div className="rail-footer">
          <div className="rail-user">
            <strong>{identity.name}</strong>
            {identity.email}
            <br />
            {t.workspaceLabel} · {roleLabel}
            {identity.isAdministrator ? ` · ${t.administratorRole}` : ""}
          </div>
          <a className="btn-quiet" href={`/account?lang=${lang}`}>
            {t.accountTitle}
          </a>
          {identity.isAdministrator && (
            <a className="btn-quiet" href={`/administration/email?lang=${lang}`}>
              {t.navEmail}
            </a>
          )}
          <SignOutButton lang={lang} action={signOutAction} />
        </div>
      </nav>
      <main className="content">{children}</main>
    </div>
  );
}
