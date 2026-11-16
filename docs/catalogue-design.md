# Catalogue population and search

Status: Q76–Q79 accepted. Existing product/variant/offer/evidence and search contracts remain accepted. Follow-up explains bounded discovery and research-quality assessment; no implementation is claimed.

## Already selected

- PostgreSQL is the system of record. Separate products, exact variants, retailer offers, price observations and source claims; keep private shopper context separate from public facts.
- Catalogue retrieval uses exact identifiers and applicable structured filters, English/Dutch full-text search and pg_trgm typo matching. Optional multilingual embeddings with pgvector augment retrieval without making an embedding provider mandatory.
- Discovery is configurable SearXNG or Tavily Search. Page evidence is independently configured built-in retrieval/extraction or Tavily Extract. No silent paid fallback.
- Reliable identifiers and configuration must agree before merging. Similar titles or vector similarity are not enough. Retailer SKUs are retailer-local.
- Claims preserve sources, times and supporting evidence. Conflicts remain visible. Manufacturer specifications and retailer offers serve different evidence roles.
- Exact, comparison and broad-discovery sufficiency rules, six-hour interactive offer reuse, new observations for daily watches and thirty-day specification refresh are already agreed.

## Verified references

- PostgreSQL full-text parsing, weighting and ranking: https://www.postgresql.org/docs/current/textsearch-controls.html .
- pg_trgm fuzzy text matching: https://www.postgresql.org/docs/current/pgtrgm.html .
- Optional hybrid lexical/vector retrieval: https://github.com/pgvector/pgvector#hybrid-search .
- Product/identifier/offer structured data vocabulary: https://schema.org/Product . Structured markup is a source claim, not proof of correctness or freshness.

## Accepted population flow

Demand or an approved import source → discover/retrieve evidence → extract product/variant/offer claims → normalize attributes/units/identifiers → resolve identity conservatively → validate/admit supported public facts → update search representations → query-time evidence evaluation and offer refresh.

No database migration or provider integration has been implemented. Schema/index/library details must be checked against implementation requirements and current primary docs. An external dedicated search engine is not a launch requirement; consider one only if measured catalogue workload requires it.

## Accepted population decisions

- Q76: Demand-driven initial population versus a broad preloaded catalogue. Selected demand-driven discovery, with repeatable development fixtures and optional approved imports; all categories remain eligible.
- Q77: Source onboarding: arbitrary web-wide crawling versus bounded page discovery and optional structured feeds/imports. Selected bounded on-demand discovery plus administrator-configured import adapters; retailer/affiliate integrations need actual source availability and authorization/terms checks before being promised.
- Q78: Admission: mandatory human approval of every discovered record versus automatic validated ingestion. Selected automatic admission of supported identity/facts with conflicts and uncertain matches kept separate; administrator review focuses on unresolved conflicts or merges.
- Q79: Background coverage: recheck every catalogue offer continuously versus prioritize active watches/recently requested items. Selected active watches on their existing schedules, stale requested offers on demand, and optional budgeted background enrichment for the rest. Catalogue breadth must not imply all stored offers are current.

Final SQL shape, import formats, source checkpoints, deletion/withdrawal semantics and coverage observability can be specified after these policy choices, without reopening the selected search/provider stack.

## Bounded discovery explained

For a particular request, propose focused search queries, inspect the most useful results and retrieve selected relevant product/specification/offer pages within the accepted caps. Ingest supported public facts from those pages for future requests. Do not recursively traverse every link or every category of every retailer. Search discovery and page-evidence extraction are separate configured capabilities.

Example only: a 27-inch USB-C monitor request generates category, feature and Dutch/English terms, then exact-model queries for candidate specification and offer gaps. Source inspection checks variant identity, actual power-delivery specification and delivered cost rather than treating the words USB-C as sufficient evidence.

A feed/API import is an operator-configured structured source, such as a retailer CSV/JSON product feed or a documented product endpoint. An adapter maps source fields into product/variant/offer claims and applies the same validation/provenance rules. No named retailer feed, API access or partnership has been established. Optional imports accelerate coverage without becoming a prerequisite for initial research.

## Research-quality clarification

Search phrases retrieve potential evidence; they do not prove quality. Record each must-have as an explicit requirement and evaluate candidate identity, relevant claim value/unit, supporting source/excerpt, source/observation time and any conflict. Use supported, contradicted and unknown assessment outcomes; unknown cannot satisfy a must-have. Deterministic checks validate types, comparisons, exact-match constraints, freshness and citation/reference existence. These checks alone cannot establish real-world truth or the correctness of every extraction.

The model interprets language and proposes candidate claims/assessments; application validation and source evidence constrain what qualifies. Qualitative claims need relevant evidence and visible limits, not the presence of marketing keywords. Conflicts stay visible and unresolved rather than being converted into a made-up confidence percentage.

Per-run quality checks cover requirement coverage, identity, evidence relevance, eligible/fresh offers, delivered price, conflicts, candidate diversity and remaining gaps. A collection of copied pages is not independent corroboration. Source count and number of queries are not quality guarantees. Broad discovery can only claim coverage among examined candidates, not global market completeness.

Runtime sufficiency and system evaluation are distinct: a run can finish with supported results, need clarification, or end partial due to limits/unavailable sources. Bilingual cross-category benchmarks use manually reviewed evidence cases for known variants, requirement satisfaction, citation correctness, delivered-price handling, conflicts, freshness, sensible clarification and honest partial outputs. Retrieval relevance and critical correctness are assessed separately. No self-reported model confidence or universal quality guarantee replaces that evaluation.
