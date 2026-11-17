# 24 — Deliver email alerts with schedules and quiet hours

**What to build:** Receive email alerts at suitable times and inspect failures while retaining in-app alerts.

**Blocked by:** 04 — Configure SMTP and test transactional delivery (GitHub #5); 22 — Watch an exact offer and receive target alerts (GitHub #23)

**Status:** ready-for-agent

- [ ] Persist delivery intent and application-level deduplication across workers/restarts; SMTP failures do not erase in-app alerts.
- [ ] Support daily timing/quiet hours in Europe/Amsterdam with controlled DST tests.
- [ ] Recheck delayed-alert relevance and owner/watch state before delivery; failed freshness validation cannot produce a current-deal claim.
- [ ] Expose bounded retries and ambiguous SMTP acceptance outcomes; test stale deals, pause/disable/delete and restart behavior via captured email/UI.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/25
