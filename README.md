# Shopping Assistant

An open source, self-hosted shopping assistant for the Netherlands, with English and Dutch support and a future paid hosted service.

**Status: walking skeleton and first-administrator setup implemented** ([issues #2](https://github.com/mohamedwaleed/shopping-assistant/issues/2) and [#3](https://github.com/mohamedwaleed/shopping-assistant/issues/3)). One development-fixture product flows PostgreSQL → core → HTTP → Studio UI behind a private workspace created by a one-time setup claim; invitations, devices/sessions management, providers, research and monitoring arrive with later tickets.

## Planned capabilities

- Describe a need and receive researched, evidence-backed recommendations across product categories.
- Compare exact product variants with interactive product details and comparison tables.
- Discover EUR retailer offers delivering to the Netherlands, with VAT and known shipping costs.
- Monitor offers and variants daily, with target-price and price-drop alerts by email and in-app notifications.
- Revisit shopping sessions and explicitly save reusable preferences.
- Bring supported AI credentials or a compatible local-model endpoint, with independently configured search/data and email providers.
- Access shopping operations through HTTP and an authenticated MCP server.

## Getting started

Requirements: Node.js ≥ 20.9, pnpm 10, Docker.

```sh
# One-command development stack: PostgreSQL + migrations/fixtures + Next.js.
docker compose -f compose.dev.yaml up
# → http://localhost:3000/setup (claim the installation once)
```

The first visit opens `/setup`. Enter the installation's one-time setup token
(`SETUP_TOKEN`, `development-setup-token` in the development stack) together
with the administrator's name, email and password; that claim creates the first
administrator and their private workspace and then stops working. No SMTP
server is needed, and the claim does not assert email ownership. Afterwards
`/sign-in` is the entry point, and `?lang=nl` switches any screen to Dutch.
Public registration stays closed: further accounts arrive through invitations
(a later ticket). Set `BETTER_AUTH_SECRET` to a generated value whenever the app
is reachable beyond your machine, and set `INSTALLATION_SECRET` (at least 16
characters) before saving credentials such as the SMTP password: it encrypts
them at rest and is held outside PostgreSQL, so changing it makes stored
credentials unreadable. `.env.example` lists both with generation commands.

The first boot installs workspace dependencies inside shared named volumes;
later starts are fast. Development Postgres publishes host port **54329** —
change the mapping in `compose.dev.yaml` if that port is taken locally.

Local verification (requires the dev Postgres from the stack above):

```sh
pnpm install
pnpm -r typecheck   # TypeScript across the workspace
pnpm -r test        # integration tests against real PostgreSQL
pnpm db:migrate     # apply Knex migrations to DATABASE_URL
pnpm db:fixtures    # load the labelled development fixture
```

Tests run against `shopping_assistant_test` (created by the Compose database
init) so they never touch development data; set `DATABASE_URL_TEST` to use a
separate database per checkout.

## Architecture

TypeScript and pnpm monorepo: a framework-independent core (`packages/core`,
shopping operations and authorization over a trusted principal), Knex/pg
storage and migrations (`packages/db`), and a Next.js web/HTTP application
(`apps/web`). Separate Node.js worker and MCP applications, and production
Docker Compose, arrive with later tickets.

Identity uses Better Auth with PostgreSQL through a verified custom Knex
adapter: Knex migrations own the identity schema, credential and session writes
join the caller's transaction, and single-use values are consumed atomically.
Workspace membership is read from the database, so a request naming another
workspace gains nothing. See [ADR 0011](docs/adr/0011-knex-better-auth-adapter-and-setup-claim.md).

Private shopper data belongs to a workspace. Public product evidence is separate, allowing a future hosted service to reuse sourced catalogue facts across workspaces while isolating private data. Each self-hosted installation maintains its own catalogue.

## Search and agent design

The agent follows application-controlled research phases with persisted requirements and evidence. Catalogue retrieval combines exact identifiers and lexical search with optional multilingual semantic search. External discovery supports configurable SearXNG or Tavily Search; page extraction independently supports the built-in retrieval pipeline or Tavily Extract. Paid fallback is explicit.

Read the [accepted agent/search design](docs/agent-search-design.md) for tool boundaries, context/state, evidence admission, ranking, research caps, freshness defaults, and evaluation requirements. Developer-added skills and external MCP integrations for the built-in agent are out of scope; the application’s shopping MCP server remains planned.

## Interface direction

The selected interface is **Studio in Electric blue**: desktop navigation, conversation and a dedicated shopping-results canvas, with responsive mobile Chat/Products/Compare views. The skeleton product view applies the approved palette and Studio composition.

## Specification

Read the [product specification](.scratch/shopping-assistant/spec.md), [domain glossary](CONTEXT.md), [architectural decisions](docs/adr/), and [agent working notes](AGENTS.md). The specification defines the complete initial release.

Work is tracked locally and in GitHub Issues. See [tracker configuration](docs/agents/issue-tracker.md).

## Open source and future hosting

The application licence is **AGPL-3.0-or-later** — see [LICENSE](LICENSE); source files carry SPDX notices. Shopping capabilities remain available to self-hosters; future paid offerings cover hosting, managed monitoring, and optional included usage. Affiliate links must be disclosed and cannot influence recommendation ranking.

## Implementation tickets

The approved implementation breakdown is published as [GitHub issues #2–#35](https://github.com/mohamedwaleed/shopping-assistant/issues?q=is%3Aissue+label%3Aready-for-agent), with [individual local tickets and dependency index](.scratch/shopping-assistant/tickets.md). Each ticket includes acceptance criteria and blockers; 57 native GitHub blocking relationships are recorded. The walking skeleton (#2) is implemented; the next frontier is [#3 — create the first administrator and private workspace](https://github.com/mohamedwaleed/shopping-assistant/issues/3).
