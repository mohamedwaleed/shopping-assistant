# 14 — Configure Tavily Search and Extract independently

**What to build:** Mix search/extraction providers and control any paid fallback.

**Blocked by:** 09 — Enforce research and monitoring budgets (GitHub #10); 13 — Discover external candidates using SearXNG (GitHub #14)

**Status:** ready-for-agent

- [ ] Support independent Tavily Search/Extract choices including SearXNG discovery with Tavily extraction.
- [ ] Route returned evidence through existing identity, permission and catalogue validation rather than treating raw content as verified.
- [ ] Paid calls and fallback are enabled explicitly and bounded by shared budgets; configuration and exhaustion are visible.
- [ ] Verify combinations, source failures, redaction and usage accounting with fixtures and separately configured live checks.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/15
