# Shopping assistant

Shopping assistance helps consumers choose products and compare retailer offers through conversation. See [CONTEXT.md](CONTEXT.md) for the domain language and [docs/adr](docs/adr) for architecture decisions.

## Licence

Copyright (C) 2026 shopping-assistant contributors

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3 or later** as published by the Free Software Foundation. See [LICENSE](LICENSE) for the full text. Because the assistant is used over a network, section 13 of the licence applies: operators running a modified version must offer its corresponding source to users.

## Layout

- `packages/config` — environment configuration: validated settings, secrets kept server-side.
- `packages/database` — PostgreSQL persistence: connection, migrations, test helpers.
- `packages/engine` — shopping logic and authorization behind public engine operations.

The agent and web packages arrive with their own tickets.

## Requirements

- Node.js 22 or newer
- pnpm 10
- Docker (for the development database)

## Configuration

The installation operator supplies `SETUP_TOKEN`, a random secret of at least 32 characters that authorizes creating the first admin. `DATABASE_URL` defaults to the development database below.

```sh
openssl rand -base64 48
```

The setup token travels in request bodies only: never in URLs, responses, or logs.

## Installation bootstrap

`createSetupServer` (from `@shopping-assistant/engine/setup-http`) serves the thin setup contract:

- `GET /setup` — readiness of the database, email, model, and search configuration, plus whether setup is still `open`. Secrets are never reported, and live provider diagnostics arrive with their adapters.
- `POST /setup/complete` — `{ "setupToken": "...", "email": "..." }` creates the initial admin and returns `201`. A wrong token is `403`, and a completed installation answers `409` for every later attempt.

Setup closes permanently once the initial admin exists, including after a restart and after every account is deleted. Two simultaneous requests produce one admin, because the database claims a single installation row rather than checking and inserting separately.

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
