# 03 — Manage devices, sessions and password changes

**What to build:** Inspect devices, revoke sessions and change the account password after recent authentication.

**Blocked by:** 02 — Create the first administrator and private workspace (GitHub #3)

**Status:** ready-for-agent

- [ ] Enforce secure HTTP-only database-backed sessions, seven-day inactivity expiry and thirty-day absolute maximum with time-controlled tests.
- [ ] List devices and sign out current/all devices with server-verified revocation.
- [ ] Require recent authentication for password changes and sensitive credential-creation authorization; email-address changes are delivered with the SMTP-backed account flows.
- [ ] Test invalid input, stale/revoked identities, account isolation and supported CSRF/origin protections.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/4
