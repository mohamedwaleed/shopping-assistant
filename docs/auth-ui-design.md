# Authentication, users and interface design

Status: approved. Auth/user lifecycle through Q75 and the unified Studio/Electric blue full-flow screen review were explicitly accepted by the user. Overall spec remains needs-info for the separate catalogue ingestion discussion, not auth/UI.

## Accepted decisions

- Q64: Better Auth with PostgreSQL runs inside the app; shopping authorization remains in the shared core.
- Q65: User identity is distinct from workspace ownership. Each initial user gets one private workspace; installation invitations do not grant access to another shopper’s space. Shared workspaces are future scope.
- Q66: Installation administrator manages users, installation providers, budgets and operational status without a routine private-conversation/credential browsing UI. Can disable users and revoke access. Database operator access is outside this application UI boundary and must be documented honestly.
- Q67: Desktop navigation/conversation/results layout; results remain associated with the session. Product selection opens details, multi-selection builds comparisons; watches have a dedicated view.
- Q68 superseded in palette only: user selected Electric blue after the modern visual exploration. Use cool neutral surfaces and electric-blue brand interactions, prominent product presentation, readable evidence and light/dark support; Studio was subsequently selected; the unified full-flow screen review was subsequently approved.
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

## Visual review scope — subsequently approved

Produce reviewable desktop/mobile screens covering onboarding, research/results, product details, comparisons, watches, settings and account/admin states. Review loading/empty/error/partial states and English/Dutch labels; mockups do not establish working auth, providers or backend functionality.

No auth code, schema or application UI implementation has been created. No Specshape workflow applies.

## Visual feedback: modern direction exploration

The user liked the initial preview’s functionality but found the visual design insufficiently modern and distinctive. The original screen styling is not approved. A new in-conversation comparison presents three proposed visual directions: Studio (persistent conversation and shopping canvas), Canvas (spacious conversational discovery and collection), and Editorial (lead product presentation with a research inspector). These were illustrative alternatives; the user subsequently selected Studio in Electric blue. Preserve accepted account/shopping flows and needs-info until the user reviews the revised visual design. JavaScript syntax was checked; browser rendering was not inspected.

## Selected palette: Electric blue

The user explicitly selected Electric blue. This replaces the earlier green direction. The user subsequently selected Studio; final screen details still require review.

| Token | Light | Dark |
|---|---|---|
| Primary action / selected state | #3158DB | #A7BEFF |
| Content on primary | #FFFFFF | #17264D |
| Subtle blue surface | #E9EFFF | #263A62 |
| App background | #F4F6FC | #161B27 |
| Panel surface | #FFFFFF | #202837 |
| Soft neutral surface | #EAF0FA | #2C374B |
| Structural border | #DCE3F1 | #38465D |
| Primary text | #202A40 | #E9EFFF |
| Secondary text | #64718A | #AAB8CF |

These are the selected preview palette values; implementation must verify contrast across actual component states. Brand blue does not replace semantic warning/error/success cues. Preserve the accepted auth and shopping behavior; overall spec stays needs-info for final screen review; layout and palette are settled.

## Selected layout: Studio

The user explicitly chose Studio from the three separately visible previews. Use the persistent desktop navigation/conversation/results composition, modern product cards, calm cool-neutral surfaces, clear typography and Electric blue interactions. Preserve responsive session Chat/Products/Compare navigation and account lifecycle contracts. Canvas and Editorial are discarded visual directions, not additional application modes.

A unified Studio/Electric blue screen review now covers all earlier account/shopping screens plus complete, researching, partial, empty and provider-unavailable research states. It retains mobile, light/dark and English/Dutch controls. These are fictional-data, in-memory examples, not application implementation. JavaScript syntax was checked; browser rendering has not been inspected. The review source remains local until finalized.

The user approved the unified screen review after selecting Studio and Electric blue. Do not reopen the chosen layout/palette or already reviewed flows unless requested. Design approval does not establish working authentication, providers or backend behavior.

## Final screen approval

The user explicitly approved the unified Studio/Electric blue screen review before opening the catalogue discussion. This supersedes historical pending-review notes above. Shopping, account, desktop/mobile and illustrated research states are the implementation design reference. The preview remains illustrative, not production code or live integration evidence.
