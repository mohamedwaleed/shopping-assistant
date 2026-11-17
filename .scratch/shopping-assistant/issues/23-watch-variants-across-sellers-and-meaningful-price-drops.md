# 23 — Watch variants across sellers and meaningful price drops

**What to build:** Monitor an established variant while retaining seller eligibility and suppressing repetitive drops.

**Blocked by:** 13 — Discover external candidates using SearXNG (GitHub #14); 22 — Watch an exact offer and receive target alerts (GitHub #23)

**Status:** ready-for-agent

- [ ] Alternate offers preserve exact configuration, condition and Netherlands delivery constraints.
- [ ] Establish the first successful baseline and compare later drops to the last notified price using configurable absolute/percentage minimum decrease.
- [ ] Specify/replay threshold rearming, repeated prices and seller/mandatory-shipping changes without duplicate noise.
- [ ] Expose observed history/gaps and distinguish advertised discount claims; test conflicts, missing prices and watch edits through the check-to-alert flow.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/24
