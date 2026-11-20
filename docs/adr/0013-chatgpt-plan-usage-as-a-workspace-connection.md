# Connect ChatGPT plan usage as a workspace-owned provider connection

ChatGPT plan usage lets an eligible shopper pay for research with the ChatGPT
plan they already have instead of an API key. It is wired as a **provider OAuth
connection owned by one private workspace** (`packages/core/src/models/chatgpt-plan.ts`),
kept deliberately apart from application sign-in, and it carries an explicit,
unresolved entitlement gate for deployments the provider has not approved.

## Separate from application identity

`chatgpt_plan_connections` has no `user` or `account` column. Authorizing a
provider stores the validated ID-token subject, a masked email hint and encrypted
tokens against the **workspace**, so a consent can never create, link or merge an
application user. A shopper still reaches the assistant only through the
invitation-controlled sign-in of ADR 0009; matching an email address proves
nothing and is never used to link the two identities.

## Consent, refresh and disconnect are protected

- **Consent.** `beginConsent` issues a fresh `state`, nonce and PKCE verifier for
  every attempt. The S256 challenge and the state travel in the authorization URL;
  the verifier is never written anywhere. The route binds the attempt to the
  browser that started it with an HttpOnly, `SameSite=Lax`, short-lived cookie
  that holds only the verifier's digest, and the callback refuses a state that
  does not match, a callback from another browser, and a cross-origin start
  (`sameOriginRejected`). A declined consent stores nothing.
- **Refresh.** The rotating refresh token is spent at the provider's token
  endpoint and the pair is replaced in one write, so a half-applied refresh
  cannot leave a consumed token behind. A terminal error (`invalid_grant`,
  `invalid_client`) disconnects the connection and asks for a new consent; a
  transient network failure changes nothing.
- **Disconnect** replaces the stored grant with unusable ciphertext and returns
  the workspace to API-key usage.
- **Account-specific model selection** only accepts a model from the account's
  own list. The list comes from `GET /v1/models` with that connection's token, so
  another account's catalogue cannot be chosen from.

## The plan route is the Responses API with its own rules

`apps/web/lib/models/ai-sdk-probe.ts` is still the only file that imports the
Vercel AI SDK. `createChatGPTPlanExercise` drives the documented plan route
(`https://api.openai.com/v1/responses`) through the pinned OpenAI adapter and
satisfies its requirements explicitly rather than relying on provider defaults:

| Requirement | How it is met |
| --- | --- |
| `store: false` | `providerOptions.openai.store` |
| `stream: true` | `streamText` (the route answers only as a stream) |
| `input` array | the prompt is sent as `input` |
| developer instruction, no system input item | `instructions` + `systemMessageMode: "developer"` |
| no `max_output_tokens` (rejected) | no output-token bound is set |
| function tools in a namespace | each tool declares `providerOptions.openai.namespace` |
| success only at `response.completed` | a stream that ends without output is a typed failure, and the provider's `error.code` is preserved |

**A text ping is not proof.** The exercise reports `toolCalls` and
`toolsExecuted` separately; the shopping tool executes inside the adapter, so a
text-only answer is recorded as text and never as a saved requirements update.
`apps/web/test/support/provider-fixtures.ts` speaks this protocol on a loopback
server and refuses a request that breaks any of the rules above with the
provider's own `subscription_sharing_unsupported_capability` error, which is how
the conformance test proves the wire shape instead of assuming it.

## States are shown, not inferred

The eligibility view (`ChatGPTPlanView`) reports the connection status,
eligibility (`eligible`, `not-enabled`, `expired`, `not-eligible`, `unavailable`,
`disconnected`), the plan's usage state and pause reason, the token expiry, the
account's masked identity and the API-key configuration that exists alongside it.
Observed outcomes are recorded per workspace in `chatgpt_plan_usage_events`, so a
screen explains *why* plan usage stopped. Expiry is observed from the stored
expiry time on every read, never assumed from a flag.

## No silent API-key billing, no cookie reuse

`usageSource` is stored with the connection and is only changed by an explicit
shopper request. A paused, expired, ineligible or refused plan ends the turn as a
typed error (`chatgpt-plan-usage-limit`, `chatgpt-plan-expired`, …); the chat
route never substitutes the configured API key, and the transport tests assert
that no API-key request is made for such a turn. Provider tokens are never read
from, or written to, browser cookies, and no plan request reuses an application
session credential.

## The unresolved entitlement gate

Official documentation describes plan usage for **open-source projects and apps
run locally or on the operator's own VM**, and directs paid or remotely hosted
apps to request access first. This installation holds no such approval, so
`CHATGPT_PLAN_ENTITLEMENT` is a constant in core:

```ts
{ status: "unresolved",
  reason: "no-provider-approval-for-remotely-hosted-deployments",
  documentedAt: "docs/model-access-design.md" }
```

It is returned in every eligibility view and shown in settings in English and
Dutch. The feature is therefore offered as a self-hosted connection an operator
configures for their own account, and never presented as an entitlement this
project has obtained. `docs/model-access-design.md` records the sources and the
limits; `docs/chatgpt-plan-deployment.md` records deployment, hosting and
licensing.

## Bounds

One exercise is one turn: `maxRetries: 0`, a 15-second network timeout and at
most three tool steps, so a refused or looping route cannot multiply spend. The
turn still reserves budget like any other provider call.
