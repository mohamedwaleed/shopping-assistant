# Agent and search technical design

Status: accepted. Q46–Q63 resolved through explicit acceptance of recommendations, the SearXNG amendment, and withdrawal of the Q57 extension feature. Ready for implementation task breakdown; application code and live provider validation are not complete.

Product requirements remain settled. This document records the focused technical design follow-up requested after publication of the product specification. No implementation is underway and no Specshape workflow applies.

## Design branches

- Agent orchestration: model freedom, application-enforced phases, tool granularity, persisted run state, clarification/resume, and completion contracts.
- Search and research: structured requirements, catalogue retrieval, bilingual matching, external discovery, page retrieval, extraction, candidate identity, admission and ranking.
- Evidence and cost: sufficiency checks, freshness, measurable limits, source failures, provider capability and spending controls.
- Context and models: bounded model context, authoritative structured state and explicit model/provider routing. The agent-extension branch was withdrawn in Q57; outward-facing shopping MCP remains in scope.
- Verification: requirement-fit, evidence quality, bilingual retrieval, false variant matches, stale prices, cancellation/recovery and cost limits at the agreed public testing boundaries.

## Verified agent capabilities

- AI SDK provides ToolLoopAgent for tool execution loops and shared runtime context separate from prompts: https://ai-sdk.dev/docs/agents/overview .
- Loop controls include stop conditions and per-step settings, including model/tools/messages: https://ai-sdk.dev/docs/agents/loop-control .
- Workflow patterns support sequential steps, parallel work, routing and evaluation; application architecture remains a project decision: https://ai-sdk.dev/docs/agents/workflows .
- Tools use input schemas and execution functions, including queued execution integration: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling .
- Provider/model management supports registry-based configuration: https://ai-sdk.dev/docs/ai-sdk-core/provider-management .
- Memory approaches have different provider coupling; project-owned persistence is the selected project design, not a framework requirement: https://ai-sdk.dev/docs/agents/memory .

The live documentation identifies itself as v7. No package is installed in this documentation-only repository, so concrete APIs and versions must be pinned and rechecked when implementation begins. No package installation is necessary for this design interview.

## Search research

- PostgreSQL text search supports language dictionaries and weighted fields; bilingual stemming alone does not translate concepts: https://www.postgresql.org/docs/current/textsearch-dictionaries.html and https://www.postgresql.org/docs/current/textsearch-controls.html .
- pg_trgm provides indexed fuzzy similarity, complementing exact identifier matching rather than replacing it: https://www.postgresql.org/docs/current/pgtrgm.html .
- pgvector documents hybrid lexical/vector retrieval and the recall implications of filtering approximate indexes: https://github.com/pgvector/pgvector#hybrid-search and https://github.com/pgvector/pgvector#filtering . Multilingual quality depends on the embedding model and evaluation data.
- Brave provides web discovery and locale controls; Netherlands-language acceptance and retailer coverage still require validation: https://api-dashboard.search.brave.com/api-reference/web/search/get .
- Tavily search exposes country/language controls and raw-content retrieval, with a separate extraction endpoint: https://docs.tavily.com/documentation/api-reference/endpoint/search and https://docs.tavily.com/documentation/api-reference/endpoint/extract . Country ranking is not delivery verification.
- Firecrawl offers discovery, retrieval and proxy locale support; caching must be explicitly controlled for fresh-offer checks: https://docs.firecrawl.dev/features/search , https://docs.firecrawl.dev/features/scrape and https://docs.firecrawl.dev/features/proxies .

These are documentation findings, not live provider integration results. No retailer coverage, extraction accuracy, pricing or production readiness is claimed.

## Accepted first technical round

- Q46: One bounded shopping agent with application-enforced research phases and persisted progress. The model assists within permission, spending and evidence constraints enforced by code.
- Q47: Exact identifiers and structured filters, lexical/trigram retrieval, plus optional multilingual semantic retrieval. Lexical operation remains available without embeddings; similarity never establishes identity or must-have verification.
- Q48: Separate discovery and page-evidence interfaces. User amendment: support configurable SearXNG alongside Tavily Search and Tavily Extract. SearXNG refers to the upstream project commonly spelled SearXNG; deployment, fallback and extraction-without-Tavily choices were settled in Q52–Q53 below.
- Q49: Application-enforced identity, eligibility, evidence and freshness checks, with model assistance for subjective suitability and missing research questions.
- Q50: Extensible category attribute registry with validated names/types/units/synonyms. Preserve unfamiliar source claims without silently activating invented schemas or filters.
- Q51 historical clarification: developer-added skills/MCPs were discussed, then withdrawn in Q57. Do not implement the extension feature. The application’s own outward-facing MCP server remains in scope.

## SearXNG and MCP facts

- SearXNG supports GET/POST search via HTTP; JSON must be enabled in the instance search formats. Public instances may disable JSON, returning HTTP 403: https://docs.searxng.org/dev/search_api.html and https://docs.searxng.org/admin/settings/settings_search.html .
- SearXNG search responses are not a substitute for retrieving and verifying an offer page. A configured instance and upstream engines need operational validation; no paid discovery API requirement does not imply zero hosting or inference cost.
- AI SDK can connect to MCP servers and consume tools, resources and prompts: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools . Concrete transport and client lifecycle APIs must be checked against the pinned version.
- The attempted AI SDK agents/skills documentation URL was unavailable. This is historical research only: the Q57 extension feature was subsequently withdrawn; do not implement an instruction loader or external MCP client registry for the agent.

## Accepted second technical round

- Q52: Optional SearXNG Compose profile and external instance URL; independent discovery/extraction providers and fallback order. Paid fallback requires explicit enablement and budget.
- Q53: Built-in fetch/structured-data/readable-content pipeline with schema-constrained model extraction and evidence excerpts as needed. Optional Tavily Extract. Report blocked or unsupported pages; no required browser automation service initially.
- Q54: Typed shopping operations with structured results, evidence references, gaps and failures. Phase-scoped tools; validation/identity resolution before catalogue writes; no general SQL tool.
- Q55: Explicit persisted state independent of chat: requirements, assumptions, phase, candidates, evidence, questions and budget. Bounded context from authoritative state and relevant history/evidence. Invalidate affected evaluations on requirement changes; summaries are not authoritative.
- Q56: Separate retrieval ranking from recommendation ranking. Code enforces exclusions and assembles ordering from evidence-linked preference assessments. Missing/failed must-haves cannot be offset by price or similarity.
- Q57: User explicitly withdrew adding skills and external MCP integrations to the built-in agent. Do not build an extension loader/configuration/registry. Normal built-in instructions/tools and the outward-facing shopping MCP server remain.
- Q58: One default conversational/research model, optional extraction and embedding overrides, capability checks and recorded provider/model usage. Embeddings optional; no hidden routing.

## Accepted final technical round

- Q59: Auto-merge only when reliable identifiers and configuration agree; retailer SKUs remain retailer-specific. Conflicts prevent merging. Models propose matches; code validates admission and exact-watch identity.
- Q60: Separate sufficiency for exact product, comparison and broad discovery. Catalogue count alone is insufficient; weak/unknown coverage triggers bounded external discovery. Persist an explicit stopping reason and describe the examined scope.
- Q61: Configurable freshness defaults: six hours for interactive offer reuse; explicit current-offer requests attempt refresh; each monitoring check needs a new observation. Recheck specifications after thirty days or upon conflict. Retain source/cache times and label stale failures; no alerts from failed checks.
- Q62: Initial per-run defaults: three minutes, eight discovery requests, twenty page retrievals, thirty evaluated candidates, twelve agent steps plus configured token/spending caps. Retries consume allowance. Stop on first cap; explicit continuation provides additional bounded allowance without bypassing higher ceilings.
- Q63: Bilingual heterogeneous evaluation dataset covering retrieval relevance, identity, evidence, uncertainty, price basis, freshness, clarification, stopping and usage. All curated safety/correctness scenarios must pass; set numerical relevance targets from baseline measurements and document failures.

## Implementation handoff

### Agent execution and persisted state

Use AI SDK ToolLoopAgent within application-enforced phases. SDK loop execution is not itself the durable state store: persisted research state belongs to the application, and the existing worker runs durable research/jobs. Typed core operations enforce access regardless of whether called from built-in tools, HTTP or the outward-facing MCP server. The model receives only the relevant bounded context, never credentials or authority supplied by external evidence.

| Phase | Agent work | Persisted outcome / enforcement |
|---|---|---|
| Requirements | Interpret request, update must-haves/preferences, identify material questions | Structured requirements, assumptions, unanswered questions; user changes invalidate affected evaluations. |
| Catalogue search | Propose structured/lexical and optional semantic queries | Candidate references and retrieval provenance; exact identity is distinct from semantic similarity. |
| Gap identification | Assess what evidence and alternatives are missing | Task-specific sufficiency outcome; code checks identity, eligibility, must-haves and freshness. |
| External research | Discover URLs, obtain page evidence, propose claims/matches | Sources, timestamps, excerpts and claims; validated mappings/admission, bounded calls and costs. |
| Evaluation | Assess subjective suitability and preference trade-offs | Evidence-linked assessments; code excludes failed must-haves and separates uncertain candidates. |
| Presentation | Explain supported shortlist/comparison and offer watch operations | Persisted structured result references, scope, timestamps, gaps and completion reason. |

Clarification suspends progress with explicit unanswered questions. Continuation resumes persisted work with a new bounded allowance. Reuse evidence when valid, but recompute evaluations invalidated by changed requirements. Cancellation and failure return the already-supported partial result rather than inventing missing evidence. Shortlisting does not implicitly authorize a watch; watch writes follow the existing explicit-request and bulk-confirmation rules.

### Search pipeline

1. Interpret the request into canonical requirements and visible assumptions, preserving model identifiers. Use canonical category attributes and validated units/synonyms where available without excluding categories lacking complete structured coverage.
2. Search catalogue identifiers and applicable structured filters, then lexical/trigram retrieval and optional multilingual semantic retrieval. Retain uncertainty: an unknown attribute is not a verified must-have match.
3. Combine retrieved candidates, distinguish products/variants/offers, and assess evidence/freshness according to exact-product, comparison or broad-discovery scope. Similarity is a discovery signal, not identity evidence.
4. When evidence or coverage is insufficient, generate bounded external queries to the configured discovery adapter. Preserve the query, provider, discovered URL and scope with the run for inspection. Dutch and English discovery must be covered by evaluation.
5. Retrieve discovered pages through the independently configured built-in pipeline or Tavily Extract. Parse structured product data and readable content; use schema-constrained extraction as needed and retain supporting evidence. Respect retrieval budgets and visibly report blocked/unsupported pages.
6. Validate extracted claims and category mappings. Resolve identifiers and configuration before merging variants; conflicts remain unverified evidence. Public facts may be reusable, while private prompts, requirements and postcode remain private.
7. Apply identity, eligibility, evidence and freshness rules, then preference ranking and delivered-price handling. Return verified recommendations and uncertain alternatives separately, with the stopping reason and coverage limitations.

Exact query-generation prompts, retrieval-fusion parameters, index choices and library versions are implementation details to benchmark within these selected contracts; they must not silently relax identity or evidence requirements.

### Provider configuration

| Capability | Selected options | Contract |
|---|---|---|
| Discovery | SearXNG or Tavily Search | Configurable adapter and fallback order; SearXNG is available through an optional Compose profile or external URL; test JSON support. |
| Page evidence | Built-in fetch/structured-data/readable-content extraction or Tavily Extract | Independent of discovery; preserve evidence and timestamps; no required browser automation. |
| Conversation/research | One configured default hosted or compatible/local model | Verify capabilities, use built-in typed tools and log usage; no hidden provider switching. |
| Extraction | Default model or configured override | Schema-constrained results require evidence and validation; count model usage against caps. |
| Semantic retrieval | Optional embedding model and PostgreSQL vector retrieval | Lexical path must work without it; multilingual quality measured rather than assumed. |
| Notifications | SMTP plus persisted in-app alerts | Existing quiet-hours, relevance, retry and deduplication contracts apply. |

A route using SearXNG plus built-in page retrieval does not require Tavily credentials. Hosting and model inference are separate costs. Paid fallback requires explicit configuration and available budget; failed free discovery never silently initiates paid calls.

### Defaults and completion

| Setting | Initial accepted default |
|---|---|
| Interactive offer reuse | Up to six hours, timestamp visible |
| Explicit current-offer request | Attempt a fresh check |
| Monitoring observation | New observation for each scheduled check |
| Specification refresh | Thirty days, or sooner on conflict |
| Research elapsed time | Three minutes per allowance |
| Discovery requests | Eight per allowance |
| Page retrievals | Twenty per allowance |
| Evaluated candidates | Thirty per allowance |
| Agent steps | Twelve per allowance |
| Token/monetary allowance | Explicit installation/workspace configuration; never implicit unlimited usage |
| Stop reason | Sufficient evidence, clarification needed, exhausted limits or unavailable sources |

These are configuration defaults, not latency, coverage or correctness guarantees. Retries consume the applicable allowance; concurrent work must respect shared spending limits. Actual library/provider behavior, cancellation, caching and usage accounting require implementation verification.

### Evaluation and remaining implementation investigation

Test the authenticated core as the main behavioral boundary, supplemented by HTTP/MCP contracts and browser workflows. Use deterministic evidence/provider fixtures and separate configured live smoke tests. Include exact configuration conflicts, retailer-SKU ambiguity, Dutch/English descriptive queries, category gaps, every cap, failed explicit refreshes, stale cached evidence and scheduled fresh checks. All curated safety/correctness cases must pass; retrieval relevance is measured separately with baseline-derived targets.

No open user-intent decisions remain in this technical round. Pin and verify library/protocol versions; select model IDs and identity/job libraries; configure monetary/token ceilings and retention; benchmark retrieval parameters and measure real Netherlands coverage during implementation. If investigation reveals a material cost/privacy/product trade-off, raise that specific decision rather than repeating the full interview.

The agent-extension feature remains out of scope. The application’s own authenticated shopping MCP server remains required. No implementation tasks, tickets or application code are created by this design handoff.
