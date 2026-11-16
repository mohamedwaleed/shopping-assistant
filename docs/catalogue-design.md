# Catalogue population and search

Status: under discussion. Existing product/variant/offer/evidence and search contracts remain accepted; the following population/operations recommendations are proposals until answered.

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

## Proposed population flow

Demand or an approved import source → discover/retrieve evidence → extract product/variant/offer claims → normalize attributes/units/identifiers → resolve identity conservatively → validate/admit supported public facts → update search representations → query-time evidence evaluation and offer refresh.

No database migration or provider integration has been implemented. Schema/index/library details must be checked against implementation requirements and current primary docs. An external dedicated search engine is not a launch requirement; consider one only if measured catalogue workload requires it.

## Decision frontier

- Q76: Demand-driven initial population versus a broad preloaded catalogue. Recommend demand-driven discovery, with repeatable development fixtures and optional approved imports; all categories remain eligible.
- Q77: Source onboarding: arbitrary web-wide crawling versus bounded page discovery and optional structured feeds/imports. Recommend bounded on-demand discovery plus administrator-configured import adapters; retailer/affiliate integrations need actual source availability and authorization/terms checks before being promised.
- Q78: Admission: mandatory human approval of every discovered record versus automatic validated ingestion. Recommend automatic admission of supported identity/facts with conflicts and uncertain matches kept separate; administrator review focuses on unresolved conflicts or merges.
- Q79: Background coverage: recheck every catalogue offer continuously versus prioritize active watches/recently requested items. Recommend active watches on their existing schedules, stale requested offers on demand, and optional budgeted background enrichment for the rest. Catalogue breadth must not imply all stored offers are current.

Final SQL shape, import formats, source checkpoints, deletion/withdrawal semantics and coverage observability can be specified after these policy choices, without reopening the selected search/provider stack.
