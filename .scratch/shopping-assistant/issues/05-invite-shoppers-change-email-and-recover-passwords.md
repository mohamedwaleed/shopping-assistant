# 05 — Invite shoppers, change email and recover passwords

**What to build:** Invite a shopper into their own private workspace and recover access using expiring email links.

**Blocked by:** 03 — Manage devices, sessions and password changes (GitHub #4); 04 — Configure SMTP and test transactional delivery (GitHub #5)

**Status:** done

- [x] Seven-day invitations are single-use/email-bound, create a private workspace and do not share another shopper's data.
- [x] Thirty-minute reset links are atomically single-use and revoke existing browser sessions; responses do not enumerate accounts.
- [x] Normal delivery requires configured SMTP; verify unavailable/delivery-failure, expiry, replay and concurrent-consumption behavior.
- [x] Document and exercise a separate operator-only administrator recovery route, not a public password override.
- [x] Email-address changes require recent authentication and confirmation of the new address before switching account identity; unavailable email cannot report a completed change.

**Integration commit:** 5eab407

**Remainder:** the core and HTTP layers landed, but no shopper-facing screens exist. `/accept-invitation` and `/reset-password` return 404, the invitation email points at `/accept-invitation`, and the account screen has no email-change form. Tracked as ticket 35 (GitHub #43).

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/6
