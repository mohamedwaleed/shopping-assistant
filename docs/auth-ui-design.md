# Authentication, users and interface design

Status: open; recommendations require user agreement. Product scope and agent/search design remain accepted.

## Already agreed

- Accounts for persisted conversations and watches; email/password, administrator invitations and public registration disabled by default.
- Workspace ownership initially serves one user; future hosted workspace isolation is required. Concrete identity/membership roles and lifecycle still need design.
- Replaceable authentication, scoped external shopping MCP access and documented self-hosted recovery.
- Chat plus product details, comparison and watch views; saved sessions, structured results, English/Dutch, progress and clear evidence/freshness states.

## Open design branches

- Auth library, identity versus workspace membership, installation administrator authority and access boundaries.
- First-run administrator claim, invitation acceptance, email verification and recovery without configured SMTP.
- Sessions, expiry, revocation, account disable/delete, workspace ownership and background-job effects.
- API/MCP credential management and scope, expiry, revocation and client connection flows.
- Primary shopping layout, mobile behavior, navigation, product cards, comparisons, watches and settings.
- Visual direction, localization and accessibility, onboarding, error/empty/loading states and reviewable screen mockups.

No auth code, database schema or UI implementation is created by this interview. Do not introduce an auth dependency or a visual style as an accepted choice before user agreement. The earlier agent/search handoff does not establish whole-product readiness.
