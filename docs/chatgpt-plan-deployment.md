# ChatGPT plan usage: deployment, hosting and licensing

Status: implemented as a self-hosted, workspace-owned provider connection with an
**unresolved entitlement gate**. Verified against the provider's official
documentation on 2026-11-19. No provider approval is held or claimed.

This page is linked from the settings screen ("Read the deployment and licensing
notes") and records what an operator may rely on.

## What is supported

| Deployment | Plan usage | Why |
| --- | --- | --- |
| Local development (`docker compose -f compose.dev.yaml up`) | Supported for the operator's own account | The provider documents plan usage for open-source projects and personal projects that run locally. |
| Private self-hosted VM you operate | Supported for the operator's own account, with the credential-transfer steps below | The provider publishes a self-hosted-VM guide for the same open-source flow. |
| Paid or remotely hosted service for other people | **Not approved.** Do not offer it | The provider directs paid or remotely hosted apps to request access first. This project has not obtained that approval. |

Everything else keeps working without plan usage: an API key or a
compatible/local endpoint is configured in `/settings` exactly as before
(ADR 0012). Plan usage is an optional extra, never a prerequisite.

## What the connection is

A ChatGPT plan connection is **provider OAuth owned by one private workspace**,
not application sign-in (ADR 0013). It:

- stores the provider account's validated subject, a masked email hint and
  encrypted tokens against the workspace — never against a user or account row;
- does not create, link or merge an application account, and does not admit
  anyone to the installation (invitations stay the only way in, ADR 0009);
- never reads or reuses a browser cookie credential for provider calls, and never
  writes a provider token to a cookie;
- changes the billing source only when the shopper explicitly asks.

## Operator steps

1. Set `INSTALLATION_SECRET` (at least 16 characters). Provider tokens are
   encrypted with it (AES-256-GCM) and it is held outside PostgreSQL; a database
   dump alone reveals nothing.
2. Keep the default public Responses endpoint
   (`https://api.openai.com/v1`). If this installation must reach the provider
   through an egress proxy, set `CHATGPT_PLAN_RESPONSES_BASE_URL` to the proxy
   base URL. `CHATGPT_PLAN_TOKEN_URL` overrides the OAuth token endpoint the same
   way. Both are installation configuration; neither is ever taken from a
   request.
3. Leave `CHATGPT_PLAN_REDIRECT_URI` at its default
   (`http://127.0.0.1:1455/auth/callback`) for a local or desktop-driven
   connection.
4. Sign in to the assistant, open `/settings`, and use **Continue with ChatGPT**.
   The provider's own consent screen is where the shopper authorizes plan usage.

### Self-hosted VM

The provider's redirect target is `127.0.0.1`, which reaches the browser's
machine, not the VM. The documented procedure is:

1. Generate and persist a stable agent host identifier for the VM. This
   installation generates one `urn:uuid:…` value per process configuration and
   reuses it across sign-ins.
2. Complete OAuth locally with the same tool and the same ChatGPT account and
   workspace you will use on the VM.
3. Transfer the resulting protected credential record to the VM over a secure
   channel (for example SSH) and let the VM own later refreshes.

The provider notes that host-specific usage attribution and revocation of
transferred sessions are not yet available; treat a transferred connection as
belonging to the VM from then on.

## Access limits and preview limitations

The plan route is the public Responses API with its own rules, which this
implementation satisfies (ADR 0013): `store: false`, `stream: true`, an `input`
array, developer instructions rather than system input items, no
`max_output_tokens`, function tools grouped in a namespace, and success only at
`response.completed`. It also has limits that no client can work around:

- the account, workspace or region may not be eligible for plan usage;
- the plan allowance can be exhausted or temporarily unverifiable, and an
  exhausted allowance can arrive after a stream has already opened;
- some tools and inputs are not accepted on this route.

Each of these is recorded as an observed state and shown in settings and chat in
English and Dutch. When the plan cannot serve a request, the turn stops with a
typed error — it is never retried and never charged to an API key behind the
shopper's back.

## Dependency licensing

This project is **AGPL-3.0-or-later** (ADR 0004) and every source file carries an
SPDX header. Plan usage is implemented with the dependencies already pinned in
ADR 0012 — the Vercel AI SDK (`ai`, `@ai-sdk/openai`) and Node's built-in
`fetch`/`crypto` — and adds **no new runtime dependency**.

The provider's own reference implementation is a separate distribution under the
**Sign-in with ChatGPT DevKit Noncommercial License v1.0**, with third-party
fonts and dependencies under their own licences. That licence is **not**
compatible with shipping AGPL code, so none of it is copied, vendored or
imported here: the OAuth flow, PKCE handling, token exchange and Responses
requests are written against the provider's published protocol documentation
only. Do not copy code or assets from that DevKit into this repository without a
licensing review.

OpenAI trademarks and brand assets remain subject to the provider's brand
guidelines; this repository ships no provider artwork and labels the action
plainly in both languages.

## Sources

- Plan usage overview and client/host model:
  <https://developers.openai.com/siwc/token-sharing-open-source>
- Registration and sign-in (scopes, PKCE, loopback callback):
  <https://developers.openai.com/siwc/token-sharing-open-source/sign-in>
- Models and inference (public Responses route, `store: false`, `stream: true`,
  `response.completed`): <https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference>
- Self-hosted VMs: <https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms>
- Token reference and lifetimes: <https://developers.openai.com/siwc/token-sharing-open-source/token-reference>
- Errors and recovery: <https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery>
- Preview limitations: <https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations>
- Cookbook integration guide and hosting waitlist:
  <https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt>
- DevKit licence: <https://github.com/openai/sign-in-with-chatgpt-devkit#licence>
