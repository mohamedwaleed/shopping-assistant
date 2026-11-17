# 05 — Invite shoppers, change email and recover passwords

**What to build:** Invite a shopper into their own private workspace and recover access using expiring email links.

**Blocked by:** 03 — Manage devices, sessions and password changes (GitHub #4); 04 — Configure SMTP and test transactional delivery (GitHub #5)

**Status:** ready-for-agent

- [ ] Seven-day invitations are single-use/email-bound, create a private workspace and do not share another shopper's data.
- [ ] Thirty-minute reset links are atomically single-use and revoke existing browser sessions; responses do not enumerate accounts.
- [ ] Normal delivery requires configured SMTP; verify unavailable/delivery-failure, expiry, replay and concurrent-consumption behavior.
- [ ] Document and exercise a separate operator-only administrator recovery route, not a public password override.
- [ ] Email-address changes require recent authentication and confirmation of the new address before switching account identity; unavailable email cannot report a completed change.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/6
