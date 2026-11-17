# 28 — Delete private data and enforce retention

**What to build:** Track private cleanup while stopping spending and preserving reusable public facts.

**Blocked by:** 20 — Save preferences and invalidate revised research (GitHub #21); 27 — Disable and restore users without resuming private work (GitHub #28)

**Status:** ready-for-agent

- [ ] Confirmed recent-auth account deletion blocks access/spending immediately and tracks idempotent removal of credentials, grants and derived private data.
- [ ] Provide configurable retention/cleanup status and minimize retained excerpts; document backup-retention implications.
- [ ] Deleting sessions preserves independently created watches; public facts do not inherit private deletion ownership.
- [ ] Test retry/resume, racing jobs, private-cache cleanup and two-workspace isolation with real storage and UI/API checks.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/29
