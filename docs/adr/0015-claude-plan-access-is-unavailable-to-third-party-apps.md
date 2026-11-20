# Claude plan access is unavailable to third-party apps; show it truthfully

Ticket 32 asks whether a deployment can see plan access in settings without
losing working Claude API-key access. The answer, from Anthropic's own published
guidance, is that a consumer Claude subscription (Free, Pro, Max, Ultra) cannot
be used by this application at all, and that the only plan-adjacent route —
linked billing — is a beta that excludes subscription plans and needs an
approved OAuth app registration. This ADR records the research, the decision and
the exact condition that would let a plan integration ship later.

**Checked: 2026-02-27.** Every claim below is quoted from a page fetched on that
date; the URLs are listed at the end. Anthropic changes these pages, so a future
change of decision needs a fresh fetch, not a re-reading of this file.

## The question

Can this self-hosted assistant let a shopper use the Claude plan they already
pay for (Pro, Max, Ultra) instead of, or alongside, a Claude Console API key?

Two sub-questions decide it:

1. Is there a permitted way to send requests on the strength of a consumer
   subscription?
2. If not, is there any permitted plan-adjacent route, and what does it need?

## What Anthropic's official documentation says

### 1. Subscription credentials are for Anthropic's own applications only

`https://code.claude.com/docs/en/legal-and-compliance` (fetched 2026-02-27),
section *Usage policy → Authentication and credential use*:

> **OAuth authentication** is intended exclusively for purchasers of Claude
> Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed
> to support ordinary use of Claude Code and other native Anthropic
> applications.

> **Developers** building products or services that interact with Claude's
> capabilities, including those using the Agent SDK, should use API key
> authentication through Claude Console or a supported cloud provider.
> **Anthropic does not permit third-party developers to offer Claude.ai login
> into their own applications, or to route requests through Free, Pro, Max, or
> Ultra plan credentials on behalf of their users. Moreover, developers may not
> collect, store, or intermediate Claude.ai credentials or session tokens** —
> sign-in to a Claude account must complete through Anthropic's own flow.

> Anthropic reserves the right to take measures to enforce these restrictions
> and may do so without prior notice.

The Help Center restates it for users,
`https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account`
(fetched 2026-02-27):

> Subscription plans can only be used by subscribers, and the usage included in
> these plans is designed to support ordinary use of native Anthropic
> applications, including the Claude web, desktop, and mobile applications and
> Claude Code.

> Use of third-party tools that misrepresent their identity to Anthropic's
> servers, attempt to route third-party traffic against subscription limits, or
> otherwise violate applicable terms or policies is prohibited and such use may
> be enforced against.

So there is **no permitted route** for this application to spend a shopper's
Pro/Max/Ultra plan. There is no "approval to request" that would change that:
the prohibition is on the credential class, not on this particular app.

### 2. The API is a separate product with separate billing

`https://support.claude.com/en/articles/9876003-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan`
(fetched 2026-02-27):

> A paid Claude subscription enhances your chat experience, and the Claude API
> is billed separately.

This is what the installation already supports: an Anthropic API key, stored
encrypted, sent only to Anthropic (ADR 0012). That mode is unaffected by any of
this and stays the supported way to use Claude here.

### 3. Plan credits reach the API only through a Console organization link

`https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers`
(fetched 2026-02-27):

> Claude Max, Ultra, and Team plans include monthly credits for the Claude API.
> To claim them, you link a Claude Console organization to your plan.
>
> **Eligible plans:** Max, Ultra, and Team … Free, Pro, and Enterprise plans
> aren't eligible.

This is the nearest thing to "plan access": a Max/Ultra/Team subscriber can move
plan value onto a Console organization. But what it produces is an **ordinary
Console API key** — the same credential class this installation already stores —
not a new kind of access. It also does not cover what this ticket asked about:
Pro is explicitly ineligible, and the credits do not apply to third-party usage
billed through linked billing.

### 4. Linked billing is the only plan-adjacent third-party route, and it excludes plans

`https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections`
(fetched 2026-02-27):

> **Eligible customers:** A customer can be billed this way only if their Claude
> Platform organization pays Anthropic directly for its API usage. Prepaid
> credits and invoiced billing both count. … **The same is true of organizations
> that have only a Claude subscription plan. Requests for them are refused with
> 403 `user_profile_not_billable`.**

> **Claude Platform OAuth is a Beta Service**: prerelease software … Endpoints,
> parameters, and behavior can change during the beta. It might not be suitable
> for production use.

`https://support.claude.com/en/articles/18467148-use-your-claude-platform-account-in-a-third-party-app`
(fetched 2026-02-27), *Who can link an app*:

> The following can't be linked: … **Claude subscription plans (Pro, Max, Ultra,
> Team, and Enterprise) can't be linked** …

`https://platform.claude.com/docs/en/manage-claude/oauth-apps/app-review`
(fetched 2026-02-27):

> A new Linked billing app starts in testing, where only the test users that you
> name can link their organizations to it. To open the app to your customers,
> you publish it, and Anthropic reviews it.

Linked billing therefore needs three things this repository does not have and
cannot assert: an Anthropic OAuth app registration created in a Console
organization we administer, client authentication through an external identity
provider (`private_key_jwt`), and Anthropic's review before any customer can
link. And even once live, it still does not accept a subscription plan.

## Decision

1. **No plan integration is built.** Not a browser impersonation, not a
   subscription-token store, not an "OAuth with your Claude account" button. Each
   of those is prohibited by the guidance quoted above, and the first two would
   also be a security defect: they would make this installation a credential
   harvester.
2. **No request is made.** Acceptance criterion 3 is conditional ("if expressly
   permitted"), and it is not permitted, so there is no bounded authenticated
   request to verify. Sending one anyway would be the violation, and a fixture
   reply would be exactly the "advertise an unverified integration" the ticket
   forbids. `testConnection` and its `diagnosticBounds()` path are untouched.
3. **Plan availability is a first-class, read-only state** in core
   (`packages/core/src/models/plan-access.ts`), surfaced in settings in both
   languages next to — and visibly separate from — the working API-key
   configuration. The states are:

   | State | Meaning here |
   | --- | --- |
   | `unavailable` | The route exists in principle but is closed to this installation or credential class. |
   | `approval-required` | A permitted route exists but needs an approval this installation does not hold. |
   | `supported` | A permitted route is verified for this deployment. **Never returned today.** |

4. **`supported` cannot be claimed without evidence.** The state is derived from
   a single route declaration that carries the evidence for it, and core refuses
   to report `supported` unless that evidence names a permitted route, an
   approval reference and the date it was checked. Today's declaration has none
   of those, so the highest state reachable is `approval-required`; a test
   asserts both the refusal and that a well-formed declaration can still reach
   `supported`, so the guard is a real guard rather than a hard-coded `false`.

## Why the state is not stored in the database

The state is a property of Anthropic's published terms and of this
installation's registrations, not of a shopper's data. Storing it would let a
row drift from the evidence it is supposed to describe, and this ticket's whole
subject is truthfulness. It is derived on read, with no migration.

## Follow-up condition that would unblock a real plan integration

A plan integration can ship when **all** of the following hold, re-checked
against Anthropic's live documentation at that time:

1. Anthropic publishes that a Claude subscription plan (Pro, Max, Ultra, Team or
   Enterprise) may be used by third-party applications, or publishes a
   subscription-credential API — and removes the "can't be linked" exclusion
   above. The linked-billing guide's eligible-customer rule is the specific
   sentence to watch: a request billed to a subscription-only organization must
   stop returning `403 user_profile_not_billable`.
2. This installation holds the registration that route requires: an approved
   Anthropic OAuth app (linked billing) with its client-authentication identity
   provider configured, or whatever the published route names.
3. The route is no longer described as a beta service unsuitable for production,
   or this installation accepts that risk explicitly.

Until then the settings panel states the reason and links to the official pages,
and API-key mode is unaffected. The declaration in
`packages/core/src/models/plan-access.ts` is the one place to change when the
condition is met; it is written so that adding evidence there is the entire
change to the availability state.

## Rejected alternatives

- **Reuse a subscription token from a local Claude Code install.** Prohibited:
  "may not collect, store, or intermediate Claude.ai credentials or session
  tokens". It also breaks the credential-ownership rule in ADR 0012.
- **Drive claude.ai in a browser session.** Prohibited: "misrepresent their
  identity to Anthropic's servers, attempt to route third-party traffic against
  subscription limits". Consumer Terms §3.7 also bars automated access other
  than via an API key.
- **Ship the panel as "coming soon" with a link-button.** That is advertising an
  unverified subscription integration, which the ticket forbids. The panel says
  `unavailable`/`approval-required` with the reason instead.
- **Sell plan credits as if they were plan access.** Max/Ultra/Team API credits
  produce an ordinary Console key, which this installation already accepts; the
  panel says so and points at the Console rather than implying more.

## Sources

All fetched 2026-02-27.

- <https://code.claude.com/docs/en/legal-and-compliance>
- <https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account>
- <https://support.claude.com/en/articles/9876003-why-is-claude-api-usage-billed-separately-from-my-paid-claude-plan>
- <https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers>
- <https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections>
- <https://support.claude.com/en/articles/18467148-use-your-claude-platform-account-in-a-third-party-app>
- <https://platform.claude.com/docs/en/manage-claude/oauth-apps/app-review>
- <https://www.anthropic.com/legal/consumer-terms> (Consumer Terms §3, "Use of
  our Services", including the prohibition on automated or non-human access
  except via an Anthropic API key)
