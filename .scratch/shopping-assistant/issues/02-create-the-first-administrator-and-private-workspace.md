# 02 — Create the first administrator and private workspace

**What to build:** Claim setup once and sign in to an isolated private workspace.

**Blocked by:** 01 — Run a catalogue-to-screen walking skeleton (GitHub #2)

**Status:** done

- [x] Verify a Knex-backed Better Auth adapter and the required atomic/transaction behavior; reconcile schema requirements with Knex migrations.
- [x] An installation-held one-time token atomically creates the first administrator and workspace, disables setup and works without SMTP.
- [x] Email/password sign-in/out and invitation-only admission enforce trusted workspace authorization in core and HTTP, including direct-call and two-workspace tests.
- [x] Deliver responsive English/Dutch Studio setup/sign-in screens without asserting email verification from operator provisioning.

**Integration commit:** 11fc88b (PR #37)

**Verification note:** behaviour confirmed on the running app and in the suite: the one-time setup claim created the first administrator and private workspace and then stopped working, email/password sign-in and sign-out were exercised against real PostgreSQL, and the bilingual setup/sign-in screens render in both languages. The Knex-backed identity adapter and its transaction behaviour are covered by `apps/web/test/knex-auth-adapter.test.ts`.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/3
