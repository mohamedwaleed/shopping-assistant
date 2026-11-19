# 04 — Configure SMTP and test transactional delivery

**What to build:** Configure protected email settings and deliberately send a diagnostic message.

**Blocked by:** 02 — Create the first administrator and private workspace (GitHub #3)

**Status:** done

- [x] Administration stores masked/protected SMTP settings and exposes connection/delivery failure states.
- [x] Use a local test inbox for repeatable verification; real recipients/credentials are explicitly configured, not inferred.
- [x] Provide a reusable mailer outcome contract and English/Dutch UI; secrets never reach logs, model context or browser output.

**Outcome:** PR #38 (squash `6863a05`)

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/5
