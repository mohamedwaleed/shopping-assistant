# 33 — Operate and restore the full self-hosted stack

**What to build:** Run development/production Compose and recover the system from a backup.

**Blocked by:** 28 — Delete private data and enforce retention (GitHub #29)

**Status:** ready-for-agent

- [ ] Run web/API, worker, outward-facing MCP and PostgreSQL with ordered migrations and optional SearXNG; expose actual missing-capability states.
- [ ] Document HTTPS/network exposure, protected secrets/encryption keys, health, upgrades, backups and operator recovery.
- [ ] Demonstrate restore of representative private/public/job state without lost isolation, exceeded budgets, fabricated history or duplicate alerts.
- [ ] Verify fresh-install/upgrade/degraded operation and AGPL licence/source notices; no hosted billing infrastructure is required.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/34
