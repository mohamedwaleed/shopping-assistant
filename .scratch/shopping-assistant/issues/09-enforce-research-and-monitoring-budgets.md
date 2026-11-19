# 09 — Enforce research and monitoring budgets

**What to build:** Set allowances and see provider work pause when a budget is exhausted.

**Blocked by:** 08 — Connect models through Vercel AI SDK provider adapters (GitHub #9)

**Status:** done

- [x] Installation ceilings cannot be bypassed by workspace overrides; interactive and background allowances are separate.
- [x] Coordinate concurrent reservations, usage and bounded retries; disclose conservative cost estimates where exact pre-call pricing is unavailable.
- [x] Require personal-key background consent and explicit paid/provider fallback; expose usage and pause reasons in settings/test execution.
- [x] Prove limits on simultaneous work, cancellation/retries and absence of silent paid-key fallback.

**Integration commit:** e1f9098

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/10
