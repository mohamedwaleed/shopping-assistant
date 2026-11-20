// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import {
  CHATGPT_PLAN_ENTITLEMENT,
  createSecretCipher,
  type BudgetView,
  type ChatGPTPlanView,
  type ModelConfigurationViewResult,
} from "@shopping/core";
import { getCore } from "@/lib/core";
import { dictionaries, resolveLang } from "@/lib/i18n";
import { requestIdentity } from "@/lib/auth/session";
import { signOutAction } from "@/app/actions";
import { SignOutButton } from "@/app/auth-forms";
import { ModelSettingsForm } from "@/app/model-settings";
import { ChatGPTPlanSettings } from "@/app/chatgpt-plan-settings";
import { BudgetSettings } from "@/app/budget-settings";

const EMPTY_VIEW: ModelConfigurationViewResult = {
  installation: { defaultModel: null, extractionModel: null, usageSource: null, credential: null },
  workspace: null,
  effective: null,
  capability: null,
  diagnostics: { bounds: { maxCalls: 4, maxOutputTokens: 64 }, limits: { maxCalls: 8, maxOutputTokens: 512 } },
};
/** Shown when the connection cannot be read; nothing is invented for it. */
const EMPTY_PLAN: ChatGPTPlanView = {
  status: "disconnected",
  eligibility: "disconnected",
  usageSource: "api-key",
  account: null,
  selectedModel: null,
  models: [],
  plan: { state: "available", reason: null, message: null, retryAfterSeconds: null },
  expiresAt: null,
  scopes: [],
  lastCheckedAt: null,
  apiKey: { configured: false, provider: null, modelId: null, source: null },
  entitlement: CHATGPT_PLAN_ENTITLEMENT,
  events: [],
};
const EMPTY_BUDGET: BudgetView = { interactiveCents: 0, backgroundCents: 0, maxInteractive: 1, maxBackground: 1, retryLimit: 0, paidFallbackEnabled: false, usedInteractiveCents: 0, usedBackgroundCents: 0, reservedInteractiveCents: 0, reservedBackgroundCents: 0, backgroundPersonalKeyConsent: false, pauseReasons: {} };

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
  let budget = EMPTY_BUDGET;
  let plan = EMPTY_PLAN;
  try {
    createSecretCipher({ key: process.env.INSTALLATION_SECRET ?? "" });
    const result = await getCore().models.read(principal);
    if (result.ok) view = result.value;
    const budgetResult = await getCore().budgets.read(principal);
    if (budgetResult.ok) budget = budgetResult.value;
    const planResult = await getCore().chatgptPlan.read(principal);
    if (planResult.ok) plan = planResult.value;
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
          <>
            <ModelSettingsForm
              lang={lang}
              canManage={isAdministrator}
              view={view}
              bounds={view.diagnostics.bounds}
            />
            <ChatGPTPlanSettings lang={lang} initial={plan} />
            <BudgetSettings lang={lang} canManage={isAdministrator} initial={budget} />
          </>
        ) : (
          <div className="error-panel" role="alert">
            {t.modelsSectionUnavailable}
          </div>
        )}
      </main>
    </div>
  );
}
