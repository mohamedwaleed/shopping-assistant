# Confirmed product decisions

- Market: Netherlands, all product categories; English and Dutch conversations.
- First public release includes needs-based research and shortlisting, product comparisons, offer discovery, and price monitoring with notifications.
- Purchase assistance ends at retailer links initially; carts, checkout, and autonomous purchasing are future capabilities.
- Workspace ownership initially serves one user; future hosting supports multiple workspaces.
- Shopping capabilities remain available to self-hosters; paid hosting, managed monitoring, and optional included usage provide future revenue.
- Affiliate revenue does not affect recommendation ranking; affiliate links are disclosed.
- Support a defined set of AI providers and a configurable compatible endpoint; configure shopping/search and notification providers separately.
- Local-model support was settled in round three: support a configurable compatible/local endpoint with capability checks.

## Original requirements retained

- Monorepo with a core engine, HTTP API, MCP server, Vercel AI SDK agent, and interactive chat UI.
- Catalogue in PostgreSQL; search the catalogue first, assess sufficiency, and research externally when needed, syncing discovered products.
- UI includes product lists and details, comparisons, notification schedules, and session navigation.
- Docker Compose for the complete local application, with development and production environments.

This document records the interview chronologically. Later rounds supersede earlier pending notes. The published product specification consolidates all accepted decisions; the product interview is complete. No implementation has started.

## Round two decisions

- No delivery deadline is imposed; a coding agent is expected to implement the application.
- Eligible initial offers: new products from business retailers delivering to the Netherlands, priced in EUR. Refurbished is an explicit shopper preference; auctions and private sellers are deferred.
- Distinguish product, variant, offer, and price observation. Compare and monitor exact variants when identified; label uncertain matches.
- Reuse adequately sourced specifications, refresh volatile offer information, and research externally when requirements or evidence are missing. Show progress and provide useful partial results when research reaches a limit; exact limits remain undecided.
- Initial watches target an exact listing or variant, with target-price and price-drop alerts, daily checks, email and in-app notifications, and last-successful-check visibility. Broad requirement watches are deferred.
- Use replaceable data providers, explicit spending limits, and visible source coverage. Unrestricted scraping of every retailer is not a launch requirement.
- Actual operating budget, expected user count, and willingness to pay for data services remain unspecified.
- Hosted workspaces may reuse public product facts and offers with provenance; conversations, preferences, credentials, and watchlists remain private. Self-hosted installations maintain their own catalogue.

## Round three decisions

- Distinguish must-have requirements and preferences. Only verified matches qualify as fully recommended; separate uncertain candidates, explain gaps, and allow fewer results.
- Ask clarifying questions when answers materially affect the shortlist; otherwise research with visible, correctable assumptions. Never silently relax must-have requirements.
- Prefer EUR totals including VAT and known mandatory delivery charges; label unknown delivery costs. Separate conditional discounts and exclude them from default ranking and alerts unless the shopper qualifies.
- Target-price alerts fire on threshold crossings. Price-drop alerts compare with the last notified price and use a configurable minimum decrease. Suppress repeat notifications for the same price. Variant watches may change sellers while preserving condition and delivery constraints.
- Installation administrators control provider credentials and hard usage limits, with optional workspace overrides. Interactive research and background monitoring have separate budgets. Exhausted budgets visibly pause affected work; background use of personal keys requires explicit opt-in.
- Accounts are required for stored conversations and watches. Support administrator and workspace credentials. Secrets must stay out of model context and browser responses.
- Support a configurable local-model endpoint; configure external search and data providers independently.
- Preserve sources, observation times, and conflicting claims. Disputed must-have attributes remain unverified. Stale offers show their last check time; alerts require a successful fresh observation.
- Desired licence policy: obligations to share modifications used in a hosted service. Round four settles the licence choice.

## Round four decisions

All recommendations for Q22–Q30 were accepted.

- Adopt AGPL-3.0-or-later for the application, including future hosted modifications. GNU AGPLv3 section 13 is the verified basis: https://www.gnu.org/licenses/agpl-3.0.html#section13 . This records the licence choice; adding the licence text and notices is implementation work.
- Store discovered claims and sources separately from resolved attributes. Search snippets identify candidates; conflicting evidence prevents verification. Prefer manufacturer evidence for specifications and retailer evidence for offers.
- Use shared fields and category-specific attributes. Comparison columns follow shopper requirements; distinguish unknown and inapplicable values. Permit comparisons across categories for the same intended use.
- Support external MCP clients from launch, with scoped search, research, comparison, and watch management. Administrator settings and provider secrets are excluded from shopping tools. HTTP and MCP enforce the same workspace permissions.
- Execute explicit watch requests and show the resulting configuration. Clarify ambiguous targets or thresholds. Confirm bulk deletion and changes affecting multiple watches.
- Persist watches and jobs. After downtime, run a fresh check and disclose observation gaps; do not infer missed prices. Use bounded retries, notification deduplication, and visible persistent failures.
- Session requirements stay within their session by default. Cross-session preferences are explicitly saved, visible when applied, and editable/deletable. Created watches retain independent settings.
- Preserve saved conversations, catalogue browsing, comparisons, and watch management during provider outages. Clearly report incomplete research. Keep in-app alerts when email fails. Provider fallback is configurable, including cost and data destination changes.
- Initial offers functionality includes current retailer listings and recorded price history. Advertised discounts remain retailer claims, labelled according to support from observed history. Coupon discovery is deferred.

## Round five decisions

All recommendations for Q31–Q39 were accepted.

- Core engine owns shopping operations and authorization. HTTP and MCP are thin adapters. Built-in agent tools call the core directly; external agents use MCP. Provider calls use replaceable interfaces.
- Separate web/API and worker processes in the monorepo, plus PostgreSQL. Docker Compose starts the complete application. Research and monitoring jobs survive process restarts.
- Chat is accompanied by dedicated product, comparison, and watch views. Interactive chat references structured persisted results. Historical recommendations and freshly checked offers are distinguished.
- Research runs have configurable time, provider-call, candidate, and spending limits; support cancellation, explicit continuation, and evidence-backed partial results. Numeric defaults require implementation calibration.
- First-run administrator setup configures AI, search/data, and email with connection checks. Stored credentials are encrypted using an installation secret outside the database. Missing providers visibly disable affected workflows.
- Initial authentication uses email/password and administrator-controlled invitations. Public registration is disabled by default. Authentication is replaceable; document self-hosted administrator recovery.
- Retention is configurable. Shoppers can delete sessions, preferences, and watches without deleting independently reusable public facts. Store only excerpts and metadata needed to substantiate claims rather than full copied pages by default.
- Select a small tested launch provider set following primary-source capability review. Document adapter limitations; compatible endpoints do not guarantee tool or structured-output support.
- Acceptance requires end-to-end evidence for English/Dutch, all shopping workflows, workspace isolation, external MCP access, spending limits, recovery, notification deduplication, and full Compose startup. Use recorded fixtures and a separately configured live smoke test.

## Round six decisions

All recommendations for Q40–Q45 were accepted and shared understanding was confirmed.

- TypeScript throughout, pnpm workspaces, Next.js for web and HTTP, and separate Node.js worker and MCP applications. Core is independent of Next.js; use PostgreSQL-backed durable jobs initially.
- Default delivery scope is the Netherlands. Request and optionally save a postcode when material, share it only with relevant providers, and label incomplete delivery totals.
- Send one initial target notification if a fresh price already meets the threshold. Establish the first successful observation as baseline for price-drop watches; subsequent notifications use the last notified price.
- Default to daily checks in Europe/Amsterdam, individual alerts after checks, configurable schedules and quiet hours, immediate in-app alerts, and delayed email with relevance recheck.
- Implementation agent selects concrete providers through current primary-source review; verify hosted AI, compatible/local AI endpoint, search/data route, and SMTP. Document coverage and limitations.
- Product design interview is complete. Consolidated specification publication was subsequently requested using to-spec, without Specshape.

## Specification publication

- The user confirmed the authenticated engine as the primary testing boundary, with thin HTTP/MCP contract checks, browser workflow checks, recorded provider fixtures, and separate live smoke tests.
- The user selected both local Markdown and GitHub Issues and authorized creation of a public repository with README.
- Repository: https://github.com/mohamedwaleed/shopping-assistant
- Published specification: https://github.com/mohamedwaleed/shopping-assistant/issues/1
- Local mirror: .scratch/shopping-assistant/spec.md
- Triage label/status: ready-for-agent.

## Implementation validation still required

Concrete provider/library choices need primary-source review. Numeric budgets, limits, freshness, retention, and performance defaults need calibration and documented rationale. This is implementation investigation, not an unfinished product interview.

## Technical design follow-up

The user identified unresolved agent and search implementation decisions and authorized a focused technical design round. Product requirements remain agreed; the local and GitHub spec are needs-info until agent orchestration and search contracts are settled. No Specshape workflow is used. Recommendations in the follow-up are proposals until explicitly accepted.

## Agent/search technical round one

Q46–Q50 accepted: controlled single-agent workflow, hybrid catalogue retrieval with optional embeddings, configurable discovery/retrieval, code-enforced evidence sufficiency, and category attribute registry. Q48 amendment adds configurable SearXNG alongside Tavily Search/Extract. Q51 clarifies that developer-added skills and MCP integrations belong to the built-in agent; exact extension contracts remain open. The specification remains needs-info pending the rest of this design round.

## Agent/search technical round two

Q52–Q56 and Q58 accepted: optional/external SearXNG, independent configurable discovery and retrieval with explicit paid fallback; built-in page retrieval/extraction without Tavily; typed phase-scoped shopping tools; authoritative persisted research state with invalidation; separate retrieval/recommendation ranking; one default model with optional extraction/embedding overrides. Q57 correction: adding skills and external MCP integrations to the built-in agent is withdrawn. Do not build its extension loader, registry or configuration. The outward-facing shopping MCP server remains in scope. The latest spec supersedes earlier extension statements.
