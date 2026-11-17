# 26 — Connect external assistants through authenticated MCP

**What to build:** Authorize a client in the browser and use shopping tools through the application MCP server.

**Blocked by:** 25 — Expose shopping operations through personal HTTP tokens (GitHub #26)

**Status:** ready-for-agent

- [ ] Use a verified current transport/protocol and maintained OAuth flow for workspace-specific sign-in/consent.
- [ ] Map core shopping operations/progress/results to scoped MCP tools with consistent validation and failures.
- [ ] Provide connected-client display/revocation and documented supported token lifetimes, audience and consent handling.
- [ ] Exercise an actual compatible client and rejected/revoked access. Do not build the withdrawn inbound extension/skill-loader feature.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/27
