# Shopping assistant

Shopping assistance helps consumers choose products and compare retailer offers through conversation. See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/adr](docs/adr) for architecture decisions.

## Licence

Copyright (C) 2026 shopping-assistant contributors

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3 or later** as published by the Free Software Foundation. See [LICENSE](LICENSE) for the full text. Because the assistant is used over a network, section 13 of the licence applies: operators running a modified version must offer its corresponding source to users.

## Layout

- `packages/config` — environment configuration: validated settings, secrets kept server-side.
- `packages/database` — PostgreSQL persistence: connection, migrations, test helpers.
- `packages/engine` — shopping logic and authorization behind public engine operations.
- `packages/agent` — the conversation model boundary: provider transports, capability diagnostics, and the model catalogue an admin chooses from. The Vercel AI SDK lives here and only here.
- `packages/web` — the HTTP and authentication boundary: Better Auth over the same knex connection, plus the email seam.

## Conversation models

An installation reaches its conversation model through one of three routes: OpenAI's own API, any OpenAI-compatible Chat Completions endpoint, or OpenRouter. The operator configures the routes and the models, and an administrator then chooses among the offered ids (`balanced`, `thorough`, `economy`).

```sh
MODEL_OPENAI_API_KEY=...                       # direct OpenAI
MODEL_OPENAI_BASE_URL=...                      # optional proxy or regional endpoint
MODEL_COMPATIBLE_BASE_URL=https://llm.internal/v1   # an OpenAI-compatible server
MODEL_COMPATIBLE_API_KEY=...                   # optional for a self-hosted server
MODEL_OPENROUTER_API_KEY=...                   # OpenRouter
MODEL_SITE_URL=https://shop.example.com        # what OpenRouter attributes traffic to
MODEL_APP_NAME=shopping-assistant
MODEL_BALANCED=openai:gpt-5-mini               # <provider>:<model>
MODEL_THOROUGH=compatible:local-large
MODEL_ECONOMY=openrouter:openai/gpt-5-mini
```

Credentials stay server-side: they are read from the environment, passed only to the provider, and never appear in a response, a usage record, or a diagnostic.

`GET /administration/models` lists the offered ids with the provider behind each and whether it is configured, plus the model a conversation would use now. An admin may set a default only to an offered id the deployment has a provider for; an id outside the operator's ceiling, or with no provider, is refused.

A model is reported as `unverified` until a diagnostic proves otherwise. `createModelProviders({ engine, configuration }).diagnose(actor, modelId)` exercises streaming and a typed tool call against the provider, and reports `ready`, `incompatible`, `unconfigured`, or `failed` with a reason. Endpoint compatibility alone never counts as support: the verdict comes from a streamed answer arriving in parts and a tool call whose arguments satisfy the declared schema. A failing provider is reported, never swapped for another one.

Each diagnostic is charged to the research ledger like any other model call, from a per-model run under the operator's account, so it is bounded by the same run, conversation, and daily ceilings. Repeated diagnostics are additionally limited per model per window.

The provider's behaviour is verified with protocol fixtures (`packages/agent/src/fixtures`) that replay recorded request bodies and recorded wire responses, so the default test run contacts no network. A live check against real providers is available and skipped unless asked for:

```sh
MODEL_LIVE_CHECK=1 node --experimental-strip-types packages/agent/scripts/live-check.ts
```

`packages/agent/scripts/record-requests.mjs` re-records the request fixtures from the SDK itself when it is upgraded.


## Requirements

- Node.js 22 or newer
- pnpm 10
- Docker (for the development database)

## Configuration

The installation operator supplies two secrets of at least 32 characters each:

- `SETUP_TOKEN` authorizes creating the first admin.
- `BETTER_AUTH_SECRET` signs session cookies and verification links. Startup fails without it.

```sh
openssl rand -base64 48
```

`DATABASE_URL` defaults to the development database below. `PUBLIC_BASE_URL` (default `http://localhost:3000`) is the origin shoppers reach: sessions and verification links are built from it.

`SMTP_URL` configures delivery and is required for invitations and password recovery: a `nodemailer` connection URL such as `smtps://user:password@smtp.example.com:465` (or `smtp://user:password@smtp.example.com:587` with STARTTLS). The relay must accept mail from the installation and deliver to the addresses it invites, and the operator's own inbox must be reachable from it, because an invitation and a reset link are only usable if the message arrives. Without `SMTP_URL`, readiness reports email as `unconfigured` and invitations and resets answer `503` rather than pretending to have sent anything.

The setup token travels in request bodies only: never in URLs, responses, or logs.

## Installation bootstrap

`createSetupServer` (from `@shopping-assistant/engine/setup-http`) serves the thin setup contract:

- `GET /setup` — readiness of the database, email, model, and search configuration, plus whether setup is still `open`. Secrets are never reported, and live provider diagnostics arrive with their adapters.
- `POST /setup/complete` — `{ "setupToken": "...", "email": "...", "password": "..." }` creates the initial admin, with the identity and credential it signs in with, and returns `201`. A wrong token is `403`, a missing password is `400`, and a completed installation answers `409` for every later attempt.

Setup closes permanently once the initial admin exists, including after a restart and after every account is deleted. Two simultaneous requests produce one admin, because the database claims a single installation row rather than checking and inserting separately.

## Accounts and sign-in

Better Auth owns identities, credentials, sessions, and verification tokens; `packages/web` mounts it under `/api/auth`:

- `POST /api/auth/sign-up/email` — `{ "name", "email", "password" }`. Creates an ordinary account (a role in the body is ignored) and emails a verification link. Refused while the installation's registration policy is closed.
- `GET /api/auth/verify-email?token=…` — verifies the address and redirects to the callback URL.
- `POST /api/auth/sign-in/email` — `{ "email", "password" }`. Requires a verified email, and sets an `HttpOnly`, `SameSite=Lax` session cookie.
- `POST /api/auth/sign-out`, `GET /api/auth/get-session` — end the session, and report the signed-in user.

`createAuthServer({ auth, engine })` serves these; `currentUser(auth, request)` resolves the signed-in shopper for engine operations. The engine only sees identities through `createIdentityStore(auth)`, and it records the profile (role) an identity owns. Passwords and session tokens never appear in a response or a log.

## Invitations and password recovery

Invitations are how an installation that has closed public sign-up still gains members. The engine's `invitations` and `passwordResets` operations decide when each is allowed; `createAuthServer` exposes them:

- `POST /api/auth/invitations` — `{ "email": "..." }`, sent with an admin's session cookie. Emails a link and answers `201 { "email", "expiresAt" }`. The token is not returned: it reached the recipient's inbox, and an admin holding it could join as them. A session belonging to an ordinary account is `403`, no session is `401`, an address with an account or a live invitation is `409`, and an installation without SMTP is `503`.
- `GET /api/auth/accept-invitation?token=…` — `200 { "email", "expiresAt" }` for a live link, so the screen can say whose address it is for; `410` for a link that is unknown, spent, or expired, all with the same body.
- `POST /api/auth/accept-invitation` — `{ "token", "name", "password" }` creates an ordinary account and answers `201 { "email", "role": "user" }`. The address is treated as verified, because the link reached it, so the account signs in immediately. Works while registration is closed: the invitation is the authorisation, and registration policy is untouched.
- `POST /api/auth/request-password-reset` — `{ "email": "..." }` emails a reset link and answers `202` with the same body whether or not the address has an account. An installation without SMTP answers `503`.
- `GET /api/auth/reset-password?token=…` — `200 { "token": "present" }` when the link carries a token, `400` when it does not. Nothing about the account is disclosed before a password is chosen; the link proves the inbox, and only `POST` decides whether it is still usable.
- `POST /api/auth/reset-password` — `{ "token", "password" }` sets the new password and answers `200 { "status": "password-reset" }`. Every session the account held is ended, since whoever knew the old password may have held one.

Invitation links are valid for seven days and reset links for one hour. Each is single use: consumption is one statement that claims the row (`UPDATE ... WHERE accepted_at IS NULL RETURNING` for invitations, `DELETE ... WHERE expiresAt > now() RETURNING` for resets), so of two simultaneous redemptions exactly one succeeds and the other answers `410`. Only the digest of an invitation token is stored. The SMTP relay must be configured as described above for either flow to work.

## Development database

```sh
docker compose -f compose.dev.yaml up -d
pnpm install
pnpm db:migrate
```

The database listens on `127.0.0.1:54329` only. `pnpm db:migrate` uses `DATABASE_URL` when set and otherwise the default development URL. To undo the latest migration, run `pnpm --filter @shopping-assistant/database migrate:rollback`.

## Checks

```sh
pnpm typecheck
pnpm test
```

Tests run against the real PostgreSQL server and create a throwaway schema per test file, so the development database and other tests are never touched. If the database is unreachable the suite fails rather than skipping.
