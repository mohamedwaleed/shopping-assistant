# Agent and search technical design

Status: under discussion; proposals are not accepted decisions.

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

## First technical decision frontier — proposed, awaiting answers

- Q46: Single bounded shopping agent with application-enforced phases versus a free tool loop or multiple specialist agents. Recommend one agent with enforced phases and persisted state.
- Q47: Lexical-only catalogue retrieval versus hybrid retrieval. Recommend structured filters and exact identifiers, lexical/trigram retrieval, and optional multilingual vector retrieval, with lexical operation preserved without embeddings.
- Q48: External discovery/retrieval architecture and launch provider. Recommend separate discovery and page-evidence interfaces; Tavily Search/Extract as first adapter candidate, with site/variant/freshness validation and optional later specialized retrieval adapters. Acceptance depends on live Netherlands coverage checks.
- Q49: Model-only evidence sufficiency versus application-enforced evidence conditions. Recommend application-enforced eligibility, identity, evidence and freshness checks, with model assistance for subjective suitability and missing research questions.
- Q50: Arbitrary extracted attribute names versus a curated category attribute registry. Recommend common fields and extensible category definitions, preserving unrecognized source claims without silently activating model-created schemas or filters.
- Q51: User-supplied executable extensions versus curated skills/tools and administrator-approved MCP integrations. Recommend trusted versioned instruction skills and explicitly approved tool bindings, with no permissions supplied by skill prose or retailer content.

Dependent topics for subsequent rounds: exact tool contracts, model roles, context/checkpoint layout, ranking/sufficiency defaults, ingestion confidence rules, retrieval escalation and research evaluation gates. Do not treat these proposals as accepted decisions.
