# 06 — Add optional authenticator two-factor authentication

**What to build:** Enroll a second factor and recover through one-time backup codes.

**Blocked by:** 03 — Manage devices, sessions and password changes (GitHub #4); 05 — Invite shoppers, change email and recover passwords (GitHub #6)

**Status:** done

- [x] Enrollment requires recent authentication and a verified authenticator code; provide protected recovery codes.
- [x] Enabled second-factor requirements apply to sign-in and sensitive changes; backup codes are atomically single-use.
- [x] Password reset alone cannot bypass the second factor; document separate recovery and test incorrect/replayed codes across responsive account screens.

**Integration commit:** `2c2aa26`

**Remainder:** None.

## Delivery constraints

Include behavior-specific verification with implementation at the highest useful boundary. Use the approved responsive English/Dutch Studio/Electric blue design, core authorization, Knex/pg storage and Knex migrations wherever this slice touches them. Fixtures are not live integration proof. Do not add the withdrawn skill/MCP extension feature, autonomous checkout, hosted billing or a fixed-category launch restriction. No source permission or provider entitlement is implied.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/7
