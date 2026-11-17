# 22 — Watch an exact offer and receive target alerts

**What to build:** Create a daily exact-offer watch and receive qualifying in-app notifications.

**Blocked by:** 15 — Make extraction resilient and expose source coverage (GitHub #16); 18 — Checkpoint and recover the SDK agent loop in durable workers (GitHub #19)

**Status:** ready-for-agent

- [ ] Explicit create/edit requests produce independent identity/condition/delivery/threshold settings; clarify ambiguity and confirm destructive bulk actions.
- [ ] Daily Europe/Amsterdam jobs obtain fresh valid observations, expose last success/failure and disclose downtime gaps.
- [ ] Implement threshold crossings and one initial qualifying alert with application-level deduplication across retries/workers.
- [ ] Personal-key work needs consent/budget and current owner access. Test pause/resume, failure/staleness rejection and session independence through UI and worker execution.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/23
