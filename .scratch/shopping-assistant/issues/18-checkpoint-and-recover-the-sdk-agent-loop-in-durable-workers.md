# 18 — Checkpoint and recover the SDK agent loop in durable workers

**What to build:** Start an SDK agent run, observe persisted progress, cancel or continue it, and resume from a worker checkpoint after restart.

**Blocked by:** 17 — Run the controlled Vercel AI SDK shopping agent loop (GitHub #18)

**Status:** ready-for-agent

- [ ] Persist phases, revisions, candidates, evidence, gaps and usage in PostgreSQL-backed worker execution; document its Knex/pool integration.
- [ ] Enforce three-minute/eight-discovery/twenty-page/thirty-candidate/twelve-step caps plus token/spending limits, including retries.
- [ ] Continuation adds explicit bounded allowance; cancellation/exhaustion retains supported partial results.
- [ ] Verify restart/lease recovery, concurrent workers, duplicate work and owner revocation before more execution/spending.
- [ ] Wrap the same agent execution in the durable worker rather than replacing its orchestration with an unrelated agent framework. Persist phase, requirement revision, safe messages/tool-result references, pending work, evidence and consumed usage at recoverable boundaries.
- [ ] Keep per-run/allowance step and spending counters cumulative across phase calls and restarts. A fresh SDK invocation or worker retry must not reset the accepted ceilings; explicit continuation is the only way to add allowance within installation/workspace limits.
- [ ] Clarification records a waiting-for-user state and resumes against the new requirement revision; reconnecting the browser reloads stored progress rather than initiating duplicate work.
- [ ] SDK in-memory state is not durable storage. Test provider-response/checkpoint failure boundaries, idempotent tool effects, changed requirements and owner revocation without promising exactly-once external model calls.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/19
