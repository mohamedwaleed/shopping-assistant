# 20 — Save preferences and invalidate revised research

**What to build:** Explicitly reuse preferences and revise requirements without retaining invalid recommendations.

**Blocked by:** 17 — Run the controlled Vercel AI SDK shopping agent loop (GitHub #18)

**Status:** ready-for-agent

- [ ] Create/list/edit/delete saved preferences, showing when they apply; ordinary session assumptions do not become durable preferences.
- [ ] Requirement changes invalidate affected assessments while preserving valid unrelated evidence and offering an explicit rerun.
- [ ] Private session deletion preserves independent watch ownership/public facts; navigation and settings retain useful provider-outage behavior.
- [ ] Test cross-session opt-in, two-workspace isolation, summary boundaries and historical result revisions through UI/core/HTTP.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/21
