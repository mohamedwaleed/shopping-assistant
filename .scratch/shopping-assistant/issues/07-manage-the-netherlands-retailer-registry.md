# 07 — Manage the Netherlands retailer registry

**What to build:** Inspect, add and pause sources with separate eligibility, permission and extraction-health states.

**Blocked by:** 02 — Create the first administrator and private workspace (GitHub #3)

**Status:** ready-for-agent

- [ ] Idempotently seed the researched fourteen entries as candidates while retaining administrator edits; no scraping permission or working adapter is assumed.
- [ ] Separate platform domains, actual sellers, categories, Netherlands delivery evidence and source acquisition policy/adapter health.
- [ ] Newly discovered sources remain candidates; support administrator control without closing discovery to the seed list or influencing rank by popularity/affiliate revenue.
- [ ] Test source-state changes, duplicates, unauthorized edits, last-failure visibility and seed updates.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/8
