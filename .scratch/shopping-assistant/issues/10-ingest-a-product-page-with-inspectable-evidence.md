# 10 — Ingest a product page with inspectable evidence

**What to build:** Submit a permitted product URL and inspect its persisted product, variant, offer and claims.

**Status:** ready-for-agent

- [ ] Bound fetching, validate source policy/network destinations and classify redirects/challenges/errors, including HTTP 200 challenge pages.
- [ ] Parse structured product/offer data, preserving identifiers, actual seller, evidence excerpts and source/observation times with Knex.
- [ ] Only merge agreeing identities/configurations; retailer SKUs are retailer-local and ambiguity remains explicit.
- [ ] Details/core/HTTP checks prove idempotence, unsafe-URL rejection, variant conflicts and failed extraction never overwriting valid observations.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/11
