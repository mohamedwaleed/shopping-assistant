// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CLAUDE_PLAN_ROUTES, planAccessView } from "@shopping/core";
import { PlanAccessPanel } from "@/app/plan-access";
import { dictionaries } from "@/lib/i18n";

// The panel is where the claim becomes visible to a shopper, so the wording is
// asserted in both languages: no advertised subscription integration, the
// reason present, and the working API-key route named as the alternative.
describe("Claude plan availability panel", () => {
  const view = planAccessView(CLAUDE_PLAN_ROUTES);

  it("states approval-required with the reason, in English", () => {
    const html = renderToStaticMarkup(createElement(PlanAccessPanel, { lang: "en", planAccess: view }));
    const t = dictionaries.en;
    expect(html).toContain(t.planAccessStateApprovalRequired);
    expect(html).toContain(t.planAccessReasonAppRegistrationMissing);
    expect(html).toContain(t.planAccessStateUnavailable);
    expect(html).toContain(t.planAccessUseApiKey);
    expect(html).toContain("2026-02-27");
    // Never claims support, and offers no control that could imply one.
    expect(html).not.toContain(t.planAccessStateSupported);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    // The reason is traceable to the official page it came from.
    expect(html).toContain("https://code.claude.com/docs/en/legal-and-compliance");
  });

  it("states approval-required with the reason, in Dutch", () => {
    const html = renderToStaticMarkup(createElement(PlanAccessPanel, { lang: "nl", planAccess: view }));
    const t = dictionaries.nl;
    expect(html).toContain(t.planAccessStateApprovalRequired);
    expect(html).toContain(t.planAccessReasonAppRegistrationMissing);
    expect(html).toContain(t.planAccessTitle);
    expect(html).not.toContain(t.planAccessStateSupported);
  });

  it("shows supported only when the declaration carries evidence", () => {
    const evidenced = planAccessView([
      {
        route: "linked-billing",
        state: "supported",
        reason: "app-registered",
        credential: "console-api-key",
        evidence: {
          permittedRoute:
            "https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections",
          approvalReference: "oauth-app-live-2026-11",
          checkedAt: "2026-11-18",
        },
      },
    ]);
    const html = renderToStaticMarkup(createElement(PlanAccessPanel, { lang: "en", planAccess: evidenced }));
    expect(html).toContain(dictionaries.en.planAccessStateSupported);
    expect(html).toContain("oauth-app-live-2026-11");
    // The follow-up hint only appears while the route is not usable.
    expect(html).not.toContain(dictionaries.en.planAccessFollowUp);
  });
});
