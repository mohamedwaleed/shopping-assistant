# Agent and search technical design

Status: partially decided; Q46–Q50 accepted with the Q48 amendment. Q51 clarified as developer extensibility. Further contracts remain open.

Product requirements remain settled. This document records the focused technical design follow-up requested after publication of the product specification. No implementation is underway and no Specshape workflow applies.

## Design branches

- Agent orchestration: model freedom, application-enforced phases, tool granularity, persisted run state, clarification/resume, and completion contracts.
- Search and research: structured requirements, catalogue retrieval, bilingual matching, external discovery, page retrieval, extraction, candidate identity, admission and ranking.
- Evidence and cost: sufficiency checks, freshness, measurable limits, source failures, provider capability and spending controls.
- Context and extension: bounded model context, authoritative structured state, trusted skills, MCP integration and provider routing.
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
- Q48: Separate discovery and page-evidence interfaces. User amendment: support configurable SearXNG alongside Tavily Search and Tavily Extract. SearXNG refers to the upstream project commonly spelled SearXNG; deployment/fallback and extraction-without-Tavily choices are still open.
- Q49: Application-enforced identity, eligibility, evidence and freshness checks, with model assistance for subjective suitability and missing research questions.
- Q50: Extensible category attribute registry with validated names/types/units/synonyms. Preserve unfamiliar source claims without silently activating invented schemas or filters.
- Q51 clarification: the developer can add skills and MCP integrations to the built-in agent. This does not request a shopper extension-upload UI. Skills configure instructions and MCP integrations add tools; exact loading/binding contracts remain open.

## SearXNG and MCP facts

- SearXNG supports GET/POST search via HTTP; JSON must be enabled in the instance search formats. Public instances may disable JSON, returning HTTP 403: https://docs.searxng.org/dev/search_api.html and https://docs.searxng.org/admin/settings/settings_search.html .
- SearXNG search responses are not a substitute for retrieving and verifying an offer page. A configured instance and upstream engines need operational validation; no paid discovery API requirement does not imply zero hosting or inference cost.
- AI SDK can connect to MCP servers and consume tools, resources and prompts: https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools . Concrete transport and client lifecycle APIs must be checked against the pinned version.
- The attempted AI SDK agents/skills documentation URL was unavailable; do not claim native support for a particular filesystem skill-loading convention without further verification. An application-owned instruction loader is a possible project design.

## Remaining design branches

- Concrete tool contracts and phase access; curated skills, developer loading and MCP lifecycle.
- Model roles and routing; bounded prompt assembly, authoritative state, checkpoints and invalidated research on changed requirements.
- Search query planning, deterministic ranking and sufficiency outcomes; exact filters versus unverified candidates.
- SearXNG deployment and provider routing; extraction without paid dependencies; escalation for blocked or dynamic pages.
- Variant identity/admission and freshness thresholds; evaluation gates and default research limits.

The accepted subset is incorporated in the mirrored product spec; keep needs-info until the remaining architecture contracts are agreed.
