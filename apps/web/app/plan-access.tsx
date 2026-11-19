// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  PlanAccessCredential,
  PlanAccessReason,
  PlanAccessRouteName,
  PlanAccessState,
  PlanAccessView,
} from "@shopping/core";
import { dictionaries, type Dictionary, type Lang } from "@/lib/i18n";

/**
 * Whether a Claude plan may be spent by this deployment (docs/adr/0013).
 *
 * This is deliberately a separate panel from the API-key form: plan access is
 * not a credential this installation can store, and reading it never sends a
 * request. Every state is shown with the reason behind it, and no control here
 * changes anything — there is nothing to configure because there is no
 * permitted route.
 */
export function PlanAccessPanel({ lang, planAccess }: { lang: Lang; planAccess: PlanAccessView }) {
  const t = dictionaries[lang];

  return (
    <section className="panel" aria-labelledby="plan-access-title">
      <h2 id="plan-access-title">{t.planAccessTitle}</h2>
      <p className="muted">{t.planAccessIntro}</p>

      <p className="plan-state" data-plan-state={planAccess.state}>
        <span className={`cap-badge cap-${planAccess.state}`}>
          {stateLabel(planAccess.state, t)}
        </span>
        <span className="muted">{reasonLabel(planAccess.reason, t)}</span>
      </p>

      <ul className="plan-routes">
        {planAccess.routes.map((route) => (
          <li key={route.route} className="plan-route" data-route-state={route.state}>
            <span className={`cap-badge cap-${route.state}`}>{stateLabel(route.state, t)}</span>
            <div>
              <strong>{routeLabel(route.route, t)}</strong>
              <p className="hint">
                {credentialLabel(route.credential, t)}
                {route.evidence ? ` · ${route.evidence.approvalReference}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <p className="muted">{t.planAccessUseApiKey}</p>
      <p className="hint">{t.planAccessNoRequest}</p>
      {planAccess.state !== "supported" && <p className="hint">{t.planAccessFollowUp}</p>}

      <p className="hint">
        {t.planAccessCheckedAt} {planAccess.checkedAt}
      </p>
      <details className="plan-sources">
        <summary>{t.planAccessSourcesTitle}</summary>
        <ul>
          {planAccess.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function stateLabel(state: PlanAccessState, t: Dictionary): string {
  switch (state) {
    case "supported":
      return t.planAccessStateSupported;
    case "unavailable":
      return t.planAccessStateUnavailable;
    case "approval-required":
      return t.planAccessStateApprovalRequired;
  }
}

function reasonLabel(reason: PlanAccessReason, t: Dictionary): string {
  switch (reason) {
    case "third-party-apps-prohibited":
      return t.planAccessReasonThirdPartyAppsProhibited;
    case "plan-credential-excluded":
      return t.planAccessReasonPlanCredentialExcluded;
    case "app-registration-missing":
      return t.planAccessReasonAppRegistrationMissing;
    case "app-registered":
      return t.planAccessReasonAppRegistered;
  }
}

function routeLabel(route: PlanAccessRouteName, t: Dictionary): string {
  switch (route) {
    case "consumer-subscription":
      return t.planAccessRouteConsumerSubscription;
    case "linked-billing":
      return t.planAccessRouteLinkedBilling;
  }
}

function credentialLabel(credential: PlanAccessCredential, t: Dictionary): string {
  return credential === "subscription-oauth"
    ? t.planAccessCredentialSubscriptionOauth
    : t.planAccessCredentialConsoleApiKey;
}
