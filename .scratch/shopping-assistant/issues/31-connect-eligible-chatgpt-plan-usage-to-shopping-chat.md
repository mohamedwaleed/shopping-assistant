# 31 — Connect eligible ChatGPT plan usage to shopping chat

**What to build:** Authorize a permitted ChatGPT plan connection and exercise a shopping tool step.

**Blocked by:** 16 — Stream persistent bilingual chat with Vercel AI SDK (GitHub #17)

**Status:** ready-for-agent

- [ ] Separate provider OAuth from application sign-in/invitations; protect consent, refresh/disconnect and account-specific model selection.
- [ ] Verify the AI SDK route against current official streaming/Responses/tool requirements and prove more than a text-only ping.
- [ ] Show eligibility/expiry/quota/usage-source states without browser-cookie reuse or silent API-key billing.
- [ ] Document supported local/private-VM deployment, paid-hosting access limits and dependency licensing; use fixtures plus a configured eligible-account live test or retain a concrete unresolved entitlement gate.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/32
