# 11 — Normalize attributes and review conflicting claims

**What to build:** Inspect canonical attributes and resolve validated mappings or merge conflicts without losing evidence.

**Blocked by:** 10 — Ingest a product page with inspectable evidence (GitHub #11)

**Status:** done

- [x] Support extensible category attributes/types/units/synonyms and common fields without excluding unknown categories.
- [x] Preserve source claims; parser/model proposals cannot silently activate invented filters or resolve conflicts.
- [x] Administrator correction/review focuses on unresolved mappings/merges and invalidates affected assessments; supported routine ingestion remains automatic.
- [x] Test mixed categories, units, contradictory variants and unauthorized/non-destructive correction through details and administration.

**Integration commit:** `2c2aa26`

**Remainder:** None.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/12
