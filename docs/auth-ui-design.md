# Authentication, users and interface design

Status: auth/user lifecycle accepted through Q75; interface direction accepted through Q69; screen mockups await visual review. Product scope and agent/search design remain accepted. Overall spec remains needs-info.

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

## Accepted lifecycle decisions

- Q70: One-time installation-held setup token, atomic first-administrator/private-workspace claim and setup disablement. No SMTP dependency or false email-ownership verification for bootstrap.
- Q71: Single-use email-bound seven-day invitations; SMTP-backed invitation delivery and thirty-minute single-use reset links. Separate documented operator-only administrator recovery. Initial administrator can operate without SMTP, with unavailable email flows visible.
- Q72: Secure HTTP-only cookie-backed database sessions; seven-day inactivity expiry, thirty-day absolute maximum, device list and current/all-device sign-out. Recent authentication for sensitive changes/credential creation; reset revokes sessions.
- Q73: Disablement revokes browser/integration access and pauses private jobs/watches/notifications; retained data may be restored but work never resumes silently. Confirmed recent-auth deletion blocks access/spending immediately, then tracks private-data removal while preserving independent public facts and documenting backup retention.
- Q74: Personal workspace-scoped HTTP tokens with chosen scopes, ninety-day default expiry, one-time display and revocation. Remote MCP uses standards-based browser sign-in and consent, established OAuth implementation, workspace-specific grants and connected-client revocation. OAuth token lifetimes follow the selected implementation and require verification.
- Q75: Email/password plus optional authenticator-app second factor and recovery codes. Social login/passkeys deferred. Password reset cannot bypass enabled two-factor authentication; separate recovery is documented.

These application policies require implementation and behavioral verification; library defaults are not proof of conformance. No auth code or database schema has been written.

## Screen review draft

An interactive design preview is available in the conversation, with screen selection for research/results, product details, comparisons, watches, provider settings, security/devices, API/MCP access, user administration, bootstrap, sign-in/two-factor, invitation and recovery. It supports desktop/mobile, light/dark and English/Dutch controls. Fictional products/prices and in-memory actions demonstrate the proposed interface; no auth, provider, storage or notification implementation is implied.

The preview is not an accepted production UI or part of the application build. Await the user's visual feedback before treating screen design as agreed. It is held locally for iteration; do not infer that its buttons establish verified backend behavior. JavaScript syntax was checked, but no browser rendering inspection was available in this environment.

## Visual review still required

Produce reviewable desktop/mobile screens covering onboarding, research/results, product details, comparisons, watches, settings and account/admin states. Review loading/empty/error/partial states and English/Dutch labels; mockups do not establish working auth, providers or backend functionality.

No auth code, schema or application UI implementation has been created. No Specshape workflow applies.

## Visual feedback: modern direction exploration

The user liked the initial preview’s functionality but found the visual design insufficiently modern and distinctive. The original screen styling is not approved. A new in-conversation comparison presents three proposed visual directions: Studio (persistent conversation and shopping canvas), Canvas (spacious conversational discovery and collection), and Editorial (lead product presentation with a research inspector). All remain illustrative; no direction has been selected. Preserve accepted account/shopping flows and needs-info until the user reviews the revised visual design. JavaScript syntax was checked; browser rendering was not inspected.
