# 25 — Expose shopping operations through personal HTTP tokens

**What to build:** Create scoped credentials and use research, comparisons and watches through HTTP.

**Blocked by:** 03 — Manage devices, sessions and password changes (GitHub #4); 19 — Extend the same agent loop with external discovery and ingestion (GitHub #20); 21 — Compare exact variants in persisted interactive tables (GitHub #22); 23 — Watch variants across sellers and meaningful price drops (GitHub #24)

**Status:** ready-for-agent

- [ ] Recent-auth settings create workspace-scoped tokens with chosen permissions, ninety-day default expiry, one-time display and revocation.
- [ ] Expose typed core search/research lifecycle/compare/watch operations with consistent validation and documented errors.
- [ ] Enforce private/background consent and bulk-write rules; no administrator/provider-secret shopping endpoints.
- [ ] Test scopes, expiry/revocation, invalid input, workspace tampering and an external research-to-watch flow.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/26
