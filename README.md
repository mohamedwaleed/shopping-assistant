# Shopping assistant

Shopping assistance helps consumers choose products and compare retailer offers through conversation. See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/adr](docs/adr) for architecture decisions.

## Licence

Copyright (C) 2026 shopping-assistant contributors

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3 or later** as published by the Free Software Foundation. See [LICENSE](LICENSE) for the full text. Because the assistant is used over a network, section 13 of the licence applies: operators running a modified version must offer its corresponding source to users.

## Layout

- `packages/config` — environment configuration: validated settings, secrets kept server-side.
- `packages/database` — PostgreSQL persistence: connection, migrations, test helpers.
- `packages/engine` — shopping logic and authorization behind public engine operations.
- `packages/web` — the HTTP and authentication boundary: Better Auth over the same knex connection, plus the email seam.

The agent package arrives with its own ticket.

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

`DATABASE_URL` defaults to the development database below. `PUBLIC_BASE_URL` (default `http://localhost:3000`) is the origin shoppers reach: sessions and verification links are built from it. `SMTP_URL` configures delivery; without it, readiness reports email as `unconfigured` and registration fails when it tries to send.

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
