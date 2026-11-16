# Agent and search technical design

Status: partially decided; Q46–Q50 and Q52–Q56/Q58 accepted, Q48 amended, Q57 extension feature withdrawn. Remaining identity, sufficiency, freshness, limit and evaluation defaults are open.

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
- Memory approaches have different provider coupling; project-owned persistence is a proposal, not a framework requirement: https://ai-sdk.dev/docs/agents/memory .

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
- The attempted AI SDK agents/skills documentation URL was unavailable; do not claim native support for a particular filesystem skill-loading convention without further verification. An application-owned instruction loader is a possible project design.

## Accepted second technical round

- Q52: Optional SearXNG Compose profile and external instance URL; independent discovery/extraction providers and fallback order. Paid fallback requires explicit enablement and budget.
- Q53: Built-in fetch/structured-data/readable-content pipeline with schema-constrained model extraction and evidence excerpts as needed. Optional Tavily Extract. Report blocked or unsupported pages; no required browser automation service initially.
- Q54: Typed shopping operations with structured results, evidence references, gaps and failures. Phase-scoped tools; validation/identity resolution before catalogue writes; no general SQL tool.
- Q55: Explicit persisted state independent of chat: requirements, assumptions, phase, candidates, evidence, questions and budget. Bounded context from authoritative state and relevant history/evidence. Invalidate affected evaluations on requirement changes; summaries are not authoritative.
- Q56: Separate retrieval ranking from recommendation ranking. Code enforces exclusions and assembles ordering from evidence-linked preference assessments. Missing/failed must-haves cannot be offset by price or similarity.
- Q57: User explicitly withdrew adding skills and external MCP integrations to the built-in agent. Do not build an extension loader/configuration/registry. Normal built-in instructions/tools and the outward-facing shopping MCP server remain.
- Q58: One default conversational/research model, optional extraction and embedding overrides, capability checks and recorded provider/model usage. Embeddings optional; no hidden routing.

## Remaining design branches

- Exact variant identity and catalogue admission rules.
- Measurable catalogue sufficiency and bounded query planning.
- Freshness thresholds for interactive offers and cached evidence.
- Initial research limits and progress when no results qualify.
- Retrieval/evidence evaluation gates across heterogeneous categories.

Keep needs-info until these remaining contracts are agreed and the final technical design is reviewed. The unavailable native-skills documentation above is historical research only and does not justify implementing the withdrawn extension feature.
