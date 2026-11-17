# 30 — Add optional multilingual semantic catalogue retrieval

**What to build:** Configure embeddings and measure descriptive retrieval against the lexical baseline.

**Blocked by:** 09 — Enforce research and monitoring budgets (GitHub #10); 12 — Search catalogue identifiers, filters and bilingual text (GitHub #13)

**Status:** ready-for-agent

- [ ] Optional pgvector augments exact/full-text/trigram candidates and filters; ordinary catalogue search needs no embedding credentials.
- [ ] Protect provider configuration, account usage and embedding-model/version metadata; rebuild changed public representations resumably.
- [ ] Show enabled/disabled/unavailable states without silent paid fallback or private-data embedding leakage.
- [ ] Benchmark bilingual/descriptive/filter cases and failure modes; similarity never establishes exact identity or verified must-haves.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/31
