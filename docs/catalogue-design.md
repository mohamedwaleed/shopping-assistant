# Catalogue population and search

Status: Q76–Q79 accepted. Existing product/variant/offer/evidence and search contracts remain accepted. Follow-up explains bounded discovery and research-quality assessment; no implementation is claimed.

## Already selected

- PostgreSQL is the system of record; Knex with the pg driver is the user-selected connection/query layer and application migration tool. Separate products, exact variants, retailer offers, price observations and source claims; keep private shopper context separate from public facts.
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

## Acquisition reliability follow-up — proposed implementation approach

The user asked how acquisition can be reliable and why Google is not blocked. Reliability has separate dimensions: fetch/access success, extraction correctness, exact-variant identity, market/price context and freshness. HTTP success or a plausible model answer alone does not establish any of them. No guarantee of all-retailer coverage is made.

Proposed pipeline: source-specific allowed acquisition policy → scheduled host-budgeted request with explicit crawler identity and timeout → response classification → structured Product/Offer parsing → maintained retailer-specific adapter when needed → independently configured permitted extraction fallback → evidence/identity/price validation → idempotent public-catalogue admission. Use model extraction only with supporting excerpts and validation; unknown required fields remain unknown. Existing no-required-browser-automation scope remains; rendering support would need a separately scoped decision, not an anti-blocking assumption.

Per-host queues coordinate concurrency across jobs, deduplicate equivalent public retrievals and reuse permitted caches. Keep postcode/account-specific representations out of shared public caches. Track source cache timestamps separately from fetch times; a fresh request is not proof of a fresh origin price. Retry temporary timeouts/5xx with bounded backoff; respect 429/Retry-After and reduce load. Mark 403/login/CAPTCHA restrictions as blocked for review rather than repeatedly evading them. Detect challenge/consent/error content even when returned with HTTP 200. Preserve a structured failure state and stale historical observations; failed checks never produce price alerts.

Maintain permission-appropriate extraction fixtures and adapter versions. A layout change that loses price/currency/identity fields should fail validation rather than overwrite known records. Track per-source request outcomes, required-field extraction completion, variant ambiguity, last success and freshness; examine price anomalies instead of accepting them as automatic drops. A small live source-coverage pilot is recommended before promising reliability, with representative category/page variants and human-checked expected fields. Proposed engineering measures are not implemented or measured yet.

### Google comparison: verified primary references

- Google provides verifiable crawler IPs/DNS, allowing site owners to distinguish actual crawlers from spoofed user-agent strings: https://developers.google.com/crawling/docs/crawlers-fetchers/verify-google-requests . Inference: allowing a recognized search crawler does not imply the site will allow our crawler.
- Google documents host-load-aware crawl behavior, HTTP caching and separate crawler categories: https://developers.google.com/crawling/docs/crawlers-fetchers/overview-google-crawlers . Its common automatic crawlers respect robots.txt; some special crawlers operate under separate arrangements. Do not generalize those arrangements to every Google visit or our app.
- Google also encounters forbidden responses and crawl failures: https://developers.google.com/crawling/docs/troubleshooting/http-status-codes and https://support.google.com/webmasters/answer/7440203 . It does not have guaranteed access to every page.
- Google renders JavaScript through a queued Chromium rendering stage; this helps dynamic-content processing, not access authorization: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics .
- Merchant Center accepts merchant-supplied files and other product data sources, so Google shopping data is not solely inferred from scraped HTML: https://support.google.com/merchants/answer/11586438 . Such feeds are not thereby available or licensed to our application.

An honest, identifiable low-load crawler and an explicit supported-source coverage report are proposed. Do not impersonate Googlebot or promise that a browser/third-party retrieval service eliminates blocks or grants reuse rights. The proposal does not change the accepted source eligibility, provider configuration or paid-fallback rules.

## Retailer registry follow-up

The user asked how to maintain Netherlands retailers and which to start with, and explicitly selected Knex. The proposed registry maintenance model and researched 14-candidate list are recorded in docs/retailer-registry.md. Retailer list membership, lawful acquisition, technical support and live Netherlands offer eligibility are distinct. No candidate is automatically scrape-enabled or proven reliable. Keep discovery extensible across all categories.
