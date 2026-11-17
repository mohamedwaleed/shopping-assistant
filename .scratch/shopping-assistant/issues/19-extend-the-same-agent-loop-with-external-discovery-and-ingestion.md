# 19 — Extend the same agent loop with external discovery and ingestion

**What to build:** When the catalogue cannot support the request, the existing SDK agent researches targeted external gaps, admits validated evidence and re-evaluates the shortlist.

**Blocked by:** 13 — Discover external candidates using SearXNG (GitHub #14); 15 — Make extraction resilient and expose source coverage (GitHub #16); 18 — Checkpoint and recover the SDK agent loop in durable workers (GitHub #19)

**Status:** ready-for-agent

- [ ] Apply task-specific sufficiency and candidate diversity, not a result-count-only completion rule.
- [ ] Plan focused Dutch/English/exact-model queries and ingest only validated permitted public evidence.
- [ ] Preserve identity uncertainty/conflicts and exclude private requirements/postcodes from shared catalogue facts.
- [ ] Test source injection, failed refresh/cache behavior and provider/cap limits; show coverage and honest completion/partial reasons with an opt-in live smoke flow.
- [ ] Expose configured SearXNG/Tavily discovery and permitted built-in/Tavily evidence retrieval as typed tools only in allowed research phases. Return normalized candidate/evidence references rather than granting arbitrary database writes.
- [ ] Loop from gap assessment to targeted discovery/retrieval, validated admission and evaluation; reuse the same SDK execution controls, bounded context, durable state and cumulative usage accounting.
- [ ] Prove a public end-to-end SDK trace that searches the catalogue first, identifies a real evidence gap, calls an external adapter, validates the discovered variant/offer and either presents supported results or explicitly remains incomplete.
- [ ] Retrieved pages cannot instruct the agent to change phases, relax must-haves or access secrets. Test malicious source instructions and repeated no-progress work under existing caps.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/20
