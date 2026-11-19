# 35 — Build the invite, recovery and email-change screens

**What to build:** A shopper who follows an invitation or recovery link lands on a working screen and finishes the flow, in English and Dutch.

**Blocked by:** None

**Status:** ready-for-agent

- [ ] `/accept-invitation` renders the token/name/password/workspace-name form, submits through the existing `core.emailLinks.acceptInvitation` path, and an expired or consumed token fails explicitly.
- [ ] `/reset-password` renders the request and completion forms; expired, replayed and concurrently consumed tokens fail explicitly and a completed reset revokes existing sessions.
- [ ] The account screen starts an email-address change and `/account/email/confirm` completes it, keeping the recent-authentication requirement.
- [ ] A test asserts every link path the API generates resolves to a route that exists.
- [ ] Both screens follow the approved bilingual Studio/Electric blue design.

## Delivery constraints

Ticket 05 (#6) shipped the core and HTTP layers without any screens, and its invitation links point at a 404. Verify at the core boundary first, then thin HTTP contract checks on real PostgreSQL.

## Parent

https://github.com/mohamedwaleed/shopping-assistant/issues/1

## GitHub

https://github.com/mohamedwaleed/shopping-assistant/issues/43
