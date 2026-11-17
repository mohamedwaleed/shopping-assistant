# 27 — Disable and restore users without resuming private work

**What to build:** Revoke access and pause private jobs/notifications while retaining restorable data.

**Blocked by:** 05 — Invite shoppers, change email and recover passwords (GitHub #6); 24 — Deliver email alerts with schedules and quiet hours (GitHub #25); 26 — Connect external assistants through authenticated MCP (GitHub #27)

**Status:** ready-for-agent

- [ ] Administrator controls expose users/operations, not private conversations or personal credential browsing.
- [ ] Disable browser/API/MCP access and prevent queued/running private work from performing further authorized actions or spending.
- [ ] Pause watches/research/notifications with visible reasons; re-enabling access does not implicitly resume them.
- [ ] Test authorization, job checkpoints, delayed email and sessions/tokens/grants across processes.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/28
