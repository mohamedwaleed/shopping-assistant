# Authentication, users and interface design

Status: direction accepted (Q64–Q69); account lifecycle/access contracts and screen mockups still open. Product scope and agent/search design remain accepted. Overall spec remains needs-info.

## Accepted decisions

- Q64: Better Auth with PostgreSQL runs inside the app; shopping authorization remains in the shared core.
- Q65: User identity is distinct from workspace ownership. Each initial user gets one private workspace; installation invitations do not grant access to another shopper’s space. Shared workspaces are future scope.
- Q66: Installation administrator manages users, installation providers, budgets and operational status without a routine private-conversation/credential browsing UI. Can disable users and revoke access. Database operator access is outside this application UI boundary and must be documented honestly.
- Q67: Desktop navigation/conversation/results layout; results remain associated with the session. Product selection opens details, multi-selection builds comparisons; watches have a dedicated view.
- Q68: Warm neutral consumer visual style, clear type, restrained green, prominent images, readable fit/price evidence, light/dark themes and explicit stale/uncertain states.
- Q69: Mobile launch support: Chat/Products/Compare within the session, preserved context, full-screen details, horizontally navigable comparison and drawer navigation.

## Existing contracts retained

Email/password, administrator invitations and public registration off by default; accounts required for saved conversations/watches. First-run setup, recovery and scoped external shopping MCP access remain required. Keep private workspace information separate from public catalogue facts.

## Verified references

- Better Auth introduction and supported identity features: https://better-auth.com/docs/introduction .
- Cookie-backed session management, expiry and session revocation: https://better-auth.com/docs/concepts/session-management .
- Email/password, verification and password recovery flows: https://better-auth.com/docs/authentication/email-password .
- HTTP MCP authorization, authorization/resource-server separation and discovery requirements: https://modelcontextprotocol.io/specification/latest/basic/authorization .

These references establish library/protocol capabilities, not completed integrations. Concrete versions and APIs require implementation verification.

## Next lifecycle decision frontier — proposals, not accepted

- Q70: First-run administrator creation using an installation-held one-time setup token, atomic claim and setup disablement. Initial setup must not require SMTP.
- Q71: Single-use, email-bound installation invitations; verification/reset flows and expiry; SMTP-free first-user operation versus later email-dependent onboarding.
- Q72: Database-backed browser sessions with explicit expiry/revocation controls, reauthentication for sensitive changes and password-reset revocation.
- Q73: Disable/delete behavior for identity, sessions, integration grants and private background work; preservation of independently reusable public catalogue facts.
- Q74: Scoped personal HTTP API tokens and standards-based HTTP MCP sign-in/consent, with expiry/revocation and no shared server-wide secret.
- Q75: Initial scope of second-factor and social-login features, distinguished from future authentication replacement.

## Visual review still required

After lifecycle agreement, produce reviewable desktop/mobile screens covering onboarding, research/results, product details, comparisons, watches, settings and account/admin states. Review loading/empty/error/partial states and English/Dutch labels; mockups do not establish working auth, providers or backend functionality.

No auth code, schema or application UI implementation has been created. No Specshape workflow applies.
