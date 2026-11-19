# Working in this repo

Self-hosted shopping assistant for the Netherlands (English/Dutch). Read
`CONTEXT.md` for domain vocabulary and `docs/adr/` for decisions before
changing code. Product spec: `.scratch/shopping-assistant/spec.md`; tickets:
`.scratch/shopping-assistant/issues/` mirrored in GitHub issues.

## Layout

- `packages/db` — Knex/pg client, application migrations (`src/migrations`,
  ordered via `migrationSource` in `src/client.ts`), development fixtures.
- `packages/core` — shopping operations + authorization. Takes a trusted
  `Principal`; HTTP/MCP stay thin. No framework dependencies.
- `apps/web` — Next.js app router UI + HTTP API routes.

## Commands

- `pnpm install`, `pnpm -r typecheck`, `pnpm test` (root `test` first runs
  `db:ensure-test-db`, so the suite self-heals the test database)
- `pnpm db:migrate` / `pnpm db:fixtures` (use `DATABASE_URL`)
- Dev stack: `docker compose -f compose.dev.yaml up` — web on :3000, Postgres
  on host port **54329** (local Postgres already occupies 5432/5433).
- Tests need the dev Postgres running and use
  `postgres://postgres:postgres@localhost:54329/shopping_assistant_test`
  (`DATABASE_URL_TEST` overrides).

## Model access

- `packages/core` owns the model registry (`src/models/`): installation
  default, workspace override, usage source, typed errors, encrypted
  credentials and the diagnostic bounds. It never imports a provider SDK.
- `apps/web/lib/models/ai-sdk-probe.ts` is the only place the Vercel AI SDK is
  imported. Versions are pinned (ADR 0012) and asserted by a test; capability
  checks run against `apps/web/test/support/provider-fixtures.ts`, a loopback
  server speaking the providers' wire protocols. Live checks are env-gated and
  skipped by default.

## Conventions

- Tests at agreed seams: core engine boundary first, thin HTTP contract
  checks, real PostgreSQL (no ORM, no in-memory fakes).
- Development fixtures are fixed-UUID rows flagged `is_development_fixture`;
  never insert them from schema migrations.
- Money: `numeric(12,2)` + `char(3)` currency, passed around as strings.
- AGPL-3.0-or-later: keep SPDX header on new source files.
- Relative imports are extensionless (`moduleResolution: Bundler`); inside
  `apps/web` import app code via the `@/` alias (e.g. `@/lib/core`). knex/pg
  are `serverExternalPackages` in `apps/web/next.config.ts`.
