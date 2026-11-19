# 36 — Harden product-page ingestion

**What to build:** Ingestion that bounds what it fetches, classifies what it gets back, and never lets a bad fetch or an ambiguous match corrupt the catalogue.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] Bound fetching by timeout, size and redirect count, validate source policy and network destinations, and classify redirects, challenges, HTTP errors and HTTP 200 challenge pages.
- [ ] Only merge agreeing product/variant identities and configurations; retailer SKUs stay retailer-local and ambiguity remains visible.
- [ ] Prove idempotence, unsafe-URL rejection, variant conflicts and that a failed extraction never overwrites valid observations.
- [ ] Report source coverage for a submitted page.

## Delivery constraints

Ticket 10 (#11) landed structured persistence with three of four acceptance criteria unmet; this ticket is that remainder. Fixtures are not live integration proof.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/44
