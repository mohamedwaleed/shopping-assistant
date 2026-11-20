// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether a deployment may spend a shopper's Claude plan (Pro/Max/Ultra/Team)
 * instead of a Console API key.
 *
 * The answer today is no: Anthropic permits subscription credentials only in
 * its own applications and forbids third-party apps from routing requests
 * through plan credentials or holding Claude.ai tokens (docs/adr/0015). This
 * module exists so settings can say that plainly, and so that a future
 * permitted route has exactly one place to be declared — with the evidence
 * that makes `supported` claimable.
 */

/**
 * `unavailable` — the route exists in principle but is closed to this
 * installation or credential class.
 * `approval-required` — a permitted route exists but needs an approval this
 * installation does not hold.
 * `supported` — a permitted route is verified for this deployment. Only
 * reachable with evidence; see `planAccessView`.
 */
export const PLAN_ACCESS_STATES = ["supported", "unavailable", "approval-required"] as const;
export type PlanAccessState = (typeof PLAN_ACCESS_STATES)[number];

/** Which published route a state describes. */
export type PlanAccessRouteName = "consumer-subscription" | "linked-billing";

/**
 * Why a route is not usable. The panel turns these into copy, so they are a
 * closed set rather than free text that could drift from the research.
 */
export const PLAN_ACCESS_REASONS = [
  /** Subscription credentials are reserved to Anthropic's own applications. */
  "third-party-apps-prohibited",
  /** The route exists but excludes subscription-only organizations. */
  "plan-credential-excluded",
  /** The route needs an approved app registration this installation lacks. */
  "app-registration-missing",
  /** The route is registered and reviewed; this installation may use it. */
  "app-registered",
] as const;
export type PlanAccessReason = (typeof PLAN_ACCESS_REASONS)[number];

/**
 * Which credential a route would actually spend. It is deliberately explicit:
 * `console-api-key` is the mode this installation already supports, so a route
 * carrying it is not a new kind of access.
 */
export type PlanAccessCredential = "subscription-oauth" | "console-api-key";

export interface PlanAccessEvidence {
  /** The published page that permits this route, so it can be re-checked. */
  permittedRoute: string;
  /** The registration or approval reference held by this installation. */
  approvalReference: string;
  /** ISO date (YYYY-MM-DD) the permission was last confirmed. */
  checkedAt: string;
}

export interface PlanAccessRoute {
  route: PlanAccessRouteName;
  state: PlanAccessState;
  reason: PlanAccessReason;
  credential: PlanAccessCredential;
  /**
   * Required for `supported`: the permission and the registration it depends
   * on. Without it the route is reported as not supported.
   */
  evidence?: PlanAccessEvidence;
}

export interface PlanAccessSource {
  label: string;
  url: string;
}

export interface PlanAccessRouteView extends PlanAccessRoute {
  /** Set only when the route is actually reported supported. */
  evidence?: PlanAccessEvidence;
}

export interface PlanAccessView {
  /** The best state any route reaches; `supported` only with evidence. */
  state: PlanAccessState;
  /** The reason behind `state`. */
  reason: PlanAccessReason;
  /** Each published route and where it stands, in the declaration's order. */
  routes: PlanAccessRouteView[];
  /** The official pages the states were resolved against. */
  sources: readonly PlanAccessSource[];
  /** ISO date the guidance was last checked. */
  checkedAt: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A route may only be reported `supported` when it names a permitted route and
 * an approval this installation holds, both dated. A claim without evidence is
 * downgraded to `approval-required`, so the UI cannot advertise an unverified
 * integration even if a declaration says so.
 */
function evidenced(route: PlanAccessRoute): boolean {
  const evidence = route.evidence;
  return (
    route.state === "supported" &&
    !!evidence &&
    isHttpsUrl(evidence.permittedRoute) &&
    evidence.approvalReference.trim().length > 0 &&
    DATE_PATTERN.test(evidence.checkedAt)
  );
}

/**
 * Resolve the route declaration into what settings shows. Nothing is fetched:
 * this is a pure function of the declaration, so the same declaration always
 * produces the same claim and no row can drift from the evidence behind it.
 */
export function planAccessView(routes: readonly PlanAccessRoute[]): PlanAccessView {
  const resolved: PlanAccessRouteView[] = routes.map((route) => {
    if (route.state !== "supported") return { ...route };
    if (evidenced(route)) return { ...route };
    // Claimed support without evidence: report the honest, weaker state.
    return { ...route, state: "approval-required", reason: "app-registration-missing" };
  });

  const supported = resolved.find((route) => route.state === "supported");
  if (supported) {
    return {
      state: "supported",
      reason: supported.reason,
      routes: resolved,
      sources: PLAN_ACCESS_SOURCES,
      checkedAt: PLAN_ACCESS_CHECKED_AT,
    };
  }
  const approval = resolved.find((route) => route.state === "approval-required");
  const best = approval ?? resolved[0];
  return {
    state: best ? best.state : "unavailable",
    reason: best ? best.reason : "third-party-apps-prohibited",
    routes: resolved,
    sources: PLAN_ACCESS_SOURCES,
    checkedAt: PLAN_ACCESS_CHECKED_AT,
  };
}

/** ISO date the guidance below was last fetched and read (docs/adr/0015). */
export const PLAN_ACCESS_CHECKED_AT = "2026-02-27";

export const PLAN_ACCESS_SOURCES: readonly PlanAccessSource[] = [
  {
    label: "Claude Code — Legal and compliance (authentication and credential use)",
    url: "https://code.claude.com/docs/en/legal-and-compliance",
  },
  {
    label: "Claude Help Center — Log in to your Claude account",
    url: "https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account",
  },
  {
    label: "Claude Help Center — Use your Claude Platform account in a third-party app",
    url: "https://support.claude.com/en/articles/18467148-use-your-claude-platform-account-in-a-third-party-app",
  },
  {
    label: "Claude Platform — Linked billing",
    url: "https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections",
  },
  {
    label: "Claude Platform — API credits for Max, Ultra, and Team plans",
    url: "https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers",
  },
];

/**
 * The declaration this installation ships with. Each entry carries the state
 * the research supports today and no evidence, because this installation holds
 * no Anthropic app registration. Changing a state to `supported` here without
 * its evidence changes nothing: `planAccessView` will refuse the claim.
 *
 * A future permitted route is declared by replacing the entry's state, reason
 * and evidence together — the follow-up condition is in docs/adr/0015.
 */
export const CLAUDE_PLAN_ROUTES: readonly PlanAccessRoute[] = [
  {
    route: "consumer-subscription",
    state: "unavailable",
    reason: "third-party-apps-prohibited",
    credential: "subscription-oauth",
  },
  {
    route: "linked-billing",
    state: "approval-required",
    reason: "app-registration-missing",
    credential: "console-api-key",
  },
];
