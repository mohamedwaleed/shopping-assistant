# 29 — Import evidence from an approved structured source

**What to build:** Configure a bounded structured import and inspect normalized results, progress and failures.

**Blocked by:** 11 — Normalize attributes and review conflicting claims (GitHub #12); 18 — Checkpoint and recover the SDK agent loop in durable workers (GitHub #19)

**Status:** ready-for-agent

- [ ] Support mapped CSV/JSON imports and one configured source-adapter contract without requiring an unavailable retailer partnership.
- [ ] Apply the same provenance, identity, unit, offer and uncertainty validation as page ingestion.
- [ ] Provide checkpointed/idempotent progress and partial failure visibility, retaining good facts when a source omits or withdraws fields.
- [ ] Verify permitted fixtures and a real source only when available; document supported format/adapter limits rather than claiming universal API import.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/30
