# 17 — Run the controlled Vercel AI SDK shopping agent loop

**What to build:** A shopper request causes a bounded multi-step agent to search catalogue evidence, evaluate fit and present structured recommendations or material clarification.

**Blocked by:** 12 — Search catalogue identifiers, filters and bilingual text (GitHub #13); 16 — Stream persistent bilingual chat with Vercel AI SDK (GitHub #17)

**Status:** ready-for-agent

- [ ] Implement controlled requirements → catalogue search → gap assessment → evaluation → presentation with phase-scoped shopping tools.
- [ ] Code checks identity, business seller, Netherlands eligibility, condition, EUR/VAT/shipping and must-have evidence; models explain subjective trade-offs.
- [ ] Separate verified/uncertain candidates and incomplete/conditional prices; affiliate revenue cannot change ranking.
- [ ] Persist result references and historical/fresh distinctions; test heterogeneous categories, false variants, postcode context, six-hour offer and thirty-day spec policy.
- [ ] Implement the selected ToolLoopAgent abstraction using the pinned AI SDK version. The SDK owns model → tool call → tool result → next model step; do not hand-roll a second competing tool-calling protocol loop.
- [ ] The application owns explicit requirements/catalogue/gap/evaluation/presentation phases and permitted transitions. Use documented per-step controls (such as prepareStep) to assemble bounded messages and select tools; every core operation separately enforces access and permitted actions.
- [ ] Register typed shopping tools for requirement updates, catalogue search, evidence inspection, candidate evaluation, clarification and result presentation, backed by actual core operations. Do not expose raw database/network credentials or a generic SQL tool.
- [ ] At each step, assemble context from authoritative requirements, recent messages, candidate/evidence references and current gaps. Tool results carry structured identifiers/evidence/gaps/errors, not unbounded raw pages.
- [ ] Configure explicit documented loop stopping controls (such as stopWhen) and application guards for step/token/cost/time allowances. A model finishing its answer is not by itself proof of sufficient research: verify deterministic evidence conditions or return clarification/partial/unavailable.
- [ ] Record inspectable phase/tool/progress outcomes without secrets. Verify multiple SDK steps, a clarification stop, denied out-of-phase tools, missing/conflicting evidence and a premature model finish through public research results and trace events.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/18
