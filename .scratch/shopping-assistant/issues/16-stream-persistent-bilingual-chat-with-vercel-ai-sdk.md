# 16 — Stream persistent bilingual chat with Vercel AI SDK

**What to build:** Describe a need in a real SDK-backed streaming chat, answer clarification questions and revisit persisted structured requirements.

**Blocked by:** 09 — Enforce research and monitoring budgets (GitHub #10)

**Status:** done

- [x] Vercel AI SDK typed tools produce visible must-haves/preferences/assumptions in English/Dutch under core authorization.
- [x] Persist session messages and authoritative structured requirements/questions separately; summaries cannot override them.
- [x] Ask material questions, preserve must-haves and record revisions; implement session navigation in the responsive Studio shell.
- [x] Verify reload/isolation, bounded secret-free context, invalid model output and provider/budget failure states.
- [x] Use the pinned Vercel AI SDK server streaming/typed message APIs and its React useChat integration with an authenticated transport; render text, typed tool states and structured-result references rather than flattening everything to prose.
- [x] Provide bounded requirements/clarification tools calling the authorized core. Persist model/UI messages and structured state; reload/context assembly keeps workspace data isolated and excludes credentials.
- [x] Verify a real request through the SDK runtime using deterministic model/provider fixtures, including streaming tool results, malformed output, cancellation/error display and persistence; a static mocked chat transcript is not completion.

**Integration commit:** `2c2aa26`

**Remainder:** None.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/17
