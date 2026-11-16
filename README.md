# Shopping Assistant

An open source, self-hosted shopping assistant for the Netherlands, with English and Dutch support and a future paid hosted service.

**Status: specification complete; application not implemented yet.**

## Planned capabilities

- Describe a need and receive researched, evidence-backed recommendations across product categories.
- Compare exact product variants with interactive product details and comparison tables.
- Discover EUR retailer offers delivering to the Netherlands, with VAT and known shipping costs.
- Monitor offers and variants daily, with target-price and price-drop alerts by email and in-app notifications.
- Revisit shopping sessions and explicitly save reusable preferences.
- Bring supported AI credentials or a compatible local-model endpoint, with independently configured search/data and email providers.
- Access shopping operations through HTTP and an authenticated MCP server.

## Architecture

TypeScript and pnpm monorepo, a framework-independent shopping engine, Next.js web/HTTP application, separate Node.js worker and MCP applications, and PostgreSQL for catalogue and durable state. Development and production Docker Compose configurations are planned.

Private shopper data belongs to a workspace. Public product evidence is separate, allowing a future hosted service to reuse sourced catalogue facts across workspaces while isolating private data. Each self-hosted installation maintains its own catalogue.

## Specification

Read the [product specification](.scratch/shopping-assistant/spec.md), [domain glossary](CONTEXT.md), and [architectural decisions](docs/adr/). The specification defines the complete initial release; setup commands will be added with the implementation.

Work is tracked locally and in GitHub Issues. See [tracker configuration](docs/agents/issue-tracker.md).

## Open source and future hosting

The selected application licence is **AGPL-3.0-or-later**. Implementation must include its licence text and applicable notices. Shopping capabilities remain available to self-hosters; future paid offerings cover hosting, managed monitoring, and optional included usage. Affiliate links must be disclosed and cannot influence recommendation ranking.
