# 12 — Search catalogue identifiers, filters and bilingual text

**What to build:** Find products by exact model, structured criteria or English/Dutch wording.

**Blocked by:** 11 — Normalize attributes and review conflicting claims (GitHub #12)

**Status:** ready-for-agent

- [ ] Combine parameterized Knex identifier/filter queries with PostgreSQL full-text and pg_trgm retrieval; preserve model identifiers.
- [ ] Test bilingual synonyms/query expansion and typo/mixed-language cases; stemming alone is not cross-language proof.
- [ ] Unknown attributes do not become verified matches; cards/details expose sources, uncertainty and timestamps.
- [ ] Responsive search/empty/error states work without model/embedding services; check behavior and representative PostgreSQL query performance.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/13
