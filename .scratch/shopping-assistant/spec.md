# Shopping Assistant — Product Specification

Status: ready-for-agent

## Problem Statement

Shoppers in the Netherlands must translate vague needs into product specifications, compare inconsistent retailer information, identify the right configurations, and repeatedly check prices themselves. Prices and advertised discounts can omit delivery costs or depend on conditions. Research quickly becomes stale, and a cheaper listing may describe a different variant.

Shoppers need an assistant that explains its recommendations, distinguishes verified facts from uncertainty, compares actual alternatives, and monitors relevant offers. Self-hosters need control over credentials, providers, costs, and private data. The project needs a useful open source edition now and architectural boundaries that allow a paid hosted service later.

## Solution

Build a self-hosted, open source shopping assistant for the Netherlands, across all product categories, with English and Dutch conversations and interface controls. The first public release includes all three workflows: needs-based research and shortlisting, product comparison, and offer discovery with daily price monitoring and notifications.

The assistant extracts must-have requirements and preferences, asks material questions, searches its PostgreSQL catalogue first, and researches externally when evidence is insufficient. It persists sourced product facts and offers, returns verified recommendations with explanations, and shows uncertain candidates separately. Interactive product lists, details, comparison tables, watch controls, and session navigation complement chat.

Users can monitor an exact retailer offer or established product variant, receive target-price or price-drop alerts through email and in-app notifications, and inspect freshness and monitoring failures. Purchasing ends at retailer links. All shopping capabilities remain available to self-hosters; future revenue comes from managed hosting, managed monitoring, and optional included usage.

## User Stories

1. As a shopper, I want to describe my needs in English or Dutch, so that I can research in my preferred language.
2. As a shopper, I want to research any product category available in the Netherlands, so that I am not limited to a narrow category catalogue.
3. As a shopper, I want my description translated into visible must-have requirements and preferences, so that I can correct misunderstandings.
4. As a shopper, I want questions when an answer would materially affect recommendations, so that research fits my actual needs.
5. As a shopper, I want research to proceed with visible assumptions when clarification is unnecessary, so that I can get useful results promptly.
6. As a shopper, I want must-have requirements preserved unless I explicitly change them, so that unsuitable products are not silently substituted.
7. As a shopper, I want existing catalogue knowledge reused when sufficiently sourced, so that repeated research is efficient.
8. As a shopper, I want external research when catalogue evidence is insufficient, so that missing products and facts can be discovered.
9. As a shopper, I want current offers refreshed, so that old prices are not represented as current.
10. As a shopper, I want research progress, so that I understand what the assistant is doing.
11. As a shopper, I want to cancel or explicitly continue research, so that I control its duration and cost.
12. As a shopper, I want useful partial results when research reaches a limit, so that completed work is not lost.
13. As a shopper, I want fully recommended products to have verified must-have matches, so that recommendations are supported by evidence.
14. As a shopper, I want uncertain candidates displayed separately with missing evidence, so that I understand their limitations.
15. As a shopper, I want fewer recommendations when only a few qualify, so that the assistant does not pad a shortlist.
16. As a shopper, I want explanations of fit and trade-offs, so that I can judge recommendations against my priorities.
17. As a shopper, I want source links and observation times, so that I can inspect the evidence and freshness.
18. As a shopper, I want disputed specifications visibly marked, so that conflicting claims do not become false certainty.
19. As a shopper, I want product models distinguished from exact variants, so that different configurations are not mixed.
20. As a shopper, I want retailer offers distinguished from products, so that seller-specific terms remain clear.
21. As a shopper, I want interactive product lists and detail views, so that I can explore recommendations beyond prose.
22. As a shopper, I want to select products for comparison, so that I can evaluate alternatives side by side.
23. As a shopper, I want comparison columns based on my requirements, so that the table emphasizes relevant differences.
24. As a shopper, I want unknown values distinguished from inapplicable ones, so that missing evidence is clear.
25. As a shopper, I want to compare products across categories when they serve the same use, so that different solutions can be considered.
26. As a shopper, I want offers from business retailers delivering to the Netherlands, so that results are relevant to where I shop.
27. As a shopper, I want new products by default and an explicit refurbished preference, so that condition is intentional.
28. As a shopper, I want EUR totals including VAT and known mandatory delivery charges, so that prices are meaningfully comparable.
29. As a shopper, I want unknown shipping costs marked, so that incomplete totals are not called the cheapest delivered option.
30. As a shopper, I want to optionally provide a postcode when delivery depends on it, so that availability and costs can be more accurate.
31. As a shopper, I want conditional discounts separated from ordinary prices, so that membership, coupon, financing, or trade-in requirements are visible.
32. As a shopper, I want conditional discounts excluded from default ranking and alerts unless I qualify, so that inaccessible prices do not mislead me.
33. As a shopper, I want advertised discounts distinguished from observed reductions, so that a retailer claim is not mistaken for verified price history.
34. As a shopper, I want recorded price history with gaps disclosed, so that I can judge observed changes without invented history.
35. As a shopper, I want retailer links, so that I can complete a purchase myself.
36. As a shopper, I want affiliate links disclosed and excluded from ranking influence, so that recommendations remain based on fit.
37. As a shopper, I want a watch for an exact offer or identified variant, so that alerts track the item I intend to buy.
38. As a shopper, I want target-price alerts, so that I know when a fresh observed price meets my threshold.
39. As a shopper, I want one initial notification when my target is already met, so that I do not miss an existing qualifying offer.
40. As a shopper, I want price-drop alerts with a configurable minimum decrease, so that insignificant changes do not create noise.
41. As a shopper, I want a clear first-observation baseline for a price-drop watch, so that subsequent changes have a meaningful reference.
42. As a shopper, I want subsequent drops compared with the last notified price, so that repeated rises and falls do not repeatedly announce the same price.
43. As a shopper, I want variant watches to retain condition and delivery constraints when sellers change, so that a cheaper unsuitable offer does not trigger an alert.
44. As a shopper, I want explicit watch requests executed with the resulting configuration displayed, so that I can verify what was scheduled.
45. As a shopper, I want clarification for ambiguous watch targets or thresholds, so that the wrong item is not monitored.
46. As a shopper, I want confirmation before bulk deletion or changes affecting multiple watches, so that large changes are deliberate.
47. As a shopper, I want daily monitoring and the last successful check displayed, so that I know how current monitoring is.
48. As a shopper, I want email and in-app alerts, so that I can learn about changes both inside and outside the application.
49. As a shopper, I want configurable schedules and quiet hours, so that email arrives at suitable times.
50. As a shopper, I want delayed email checked for continued relevance, so that an expired deal is not sent as current.
51. As a shopper, I want to pause and resume watches, so that monitoring follows my needs.
52. As a shopper, I want monitoring to recover after downtime without inventing missed prices, so that gaps are honest and work resumes.
53. As a shopper, I want duplicate alert suppression and visible delivery failures, so that I can trust notifications.
54. As a shopper, I want in-app alerts retained when email fails, so that notification information is still available.
55. As a shopper, I want to navigate and revisit shopping sessions, so that I can continue prior research.
56. As a shopper, I want historical recommendations distinguished from fresh offers, so that old results are not mistaken for current evidence.
57. As a shopper, I want requirements scoped to a session by default, so that unrelated shopping tasks do not inherit assumptions.
58. As a shopper, I want explicit saved preferences I can inspect, edit, and delete, so that reusable personalization stays under my control.
59. As a shopper, I want applied saved preferences displayed, so that their effect on research is visible.
60. As a shopper, I want watches to retain independent settings, so that changing or deleting a session does not silently alter monitoring.
61. As a shopper, I want to delete sessions, saved preferences, and watches, so that I control private retained information.
62. As a shopper, I want access to saved content, catalogue browsing, comparisons, and watch management during provider outages, so that external failures do not make everything unusable.
63. As a shopper, I want private data isolated within my workspace, so that other workspaces cannot access my conversations or credentials.
64. As a shopper, I want to supply supported AI credentials or a compatible local-model endpoint, so that I can choose how model inference is provided.
65. As a shopper, I want explicit consent before background monitoring uses my personal provider keys, so that unattended usage is intentional.
66. As an administrator, I want a first-run setup flow and provider connection checks, so that I can configure a usable installation.
67. As an administrator, I want administrator credentials with optional workspace overrides, so that shared defaults and personal configurations can coexist.
68. As an administrator, I want separate AI, search/data, and notification configuration, so that changing one integration does not require changing every provider.
69. As an administrator, I want encrypted stored keys that never appear in model context or browser responses, so that configuration does not expose secrets.
70. As an administrator, I want hard usage limits and separate interactive and monitoring budgets, so that costs stay bounded.
71. As an administrator, I want exhausted budgets to pause affected work visibly, so that the assistant cannot silently keep spending.
72. As an administrator, I want fallback providers explicitly configured, so that changes in cost or data destination are intentional.
73. As an administrator, I want email/password access with invitations and public registration disabled, so that participation is controlled.
74. As an administrator, I want documented account recovery, so that I can regain access to a self-hosted installation.
75. As an administrator, I want configurable retention and backup/recovery documentation, so that storage and continuity are manageable.
76. As a self-hoster, I want Docker Compose to run the full application in development and production configurations, so that deployment does not require assembling services manually.
77. As a self-hoster, I want missing provider capabilities displayed, so that I know which workflows require further setup.
78. As a self-hoster, I want an independent catalogue and all shopping capabilities, so that the open source edition is useful without paid hosting.
79. As an external-agent user, I want scoped MCP tools for search, research, comparison, and watches, so that I can use my preferred assistant.
80. As an API consumer, I want HTTP access to the same shopping operations and permissions, so that integrations behave consistently.
81. As an external-agent user, I want provider secrets and administrator configuration excluded from shopping tools, so that an assistant has only relevant authority.
82. As a maintainer, I want replaceable providers with documented, verified capabilities, so that vendor changes do not require rewriting shopping logic.
83. As a maintainer, I want public product facts reusable across future hosted workspaces while private data stays isolated, so that shared research does not compromise privacy.
84. As a maintainer, I want deterministic behavioral checks and separately configured live smoke tests, so that correctness and actual integration readiness can both be assessed.
85. As a maintainer, I want an AGPL-licensed project and an architecture suitable for paid hosting, so that hosted modifications remain subject to the chosen source-sharing policy while services can earn revenue.
86. As a self-hoster, I want to configure SearXNG or Tavily Search separately from page extraction, so that paid search is not mandatory and providers can be mixed.
87. As a developer, I want the built-in agent to call typed shopping operations, so that research behavior stays testable and consistent with HTTP and MCP access.

## Implementation Decisions

- **Variant identity/admission:** Automatically merge listings only when reliable identifiers and configuration attributes agree. Retailer SKUs are retailer-specific. Conflicting identifiers or configuration prevent merging; retain uncertain candidates separately. Models can propose identity matches, but code validates before merging or attaching exact-variant watches.
- **Task-specific sufficiency:** Exact-product research requires established identity, requested specifications and fresh eligible offers. Comparison requires established variants and evidence for relevant attributes. Broad discovery evaluates requirement coverage and candidate diversity; weak or unknown catalogue coverage triggers bounded external research even if a few catalogue candidates match. Record completion reason: sufficient evidence, clarification needed, exhausted limits or unavailable sources. Describe recommendations within examined candidates, not as an exhaustive market result.
- **Freshness defaults:** Interactive offer observations may be reused for up to six hours with visible timestamps. Explicit current-offer requests attempt a fresh check. Each scheduled monitoring check obtains a new observation rather than reusing the previous one. Recheck specifications after thirty days or sooner when conflicting evidence appears. Preserve provider/cache timestamps where available. Failed refreshes leave old observations marked stale and cannot generate alerts. All intervals are configurable.
- **Initial research caps:** Per run, default to three minutes, eight discovery requests, twenty page retrievals, thirty evaluated candidates and twelve agent steps, plus separately configured token/spending caps. Count retries against the relevant caps. Stop at the first exhausted allowance and return useful partial results. Explicit continuation grants an additional allowance subject to installation/workspace ceilings. These are configurable starting settings to calibrate, not promised response times or mandatory API spending.

- **Technical design complete:** Q46–Q63 are resolved, including configurable SearXNG/Tavily, the Q57 extension withdrawal, and accepted identity, sufficiency, freshness, limit, and evaluation defaults. Implementation can be broken into behavior-focused tasks without repeating the product interview.
- **Search deployment and routing:** Provide an optional SearXNG Compose profile and external-instance URL configuration, with JSON capability checks. Discovery, extraction and fallback order are separately configurable. Never switch to paid Tavily without enabled fallback and available budget.
- **Built-in retrieval:** Fetch pages and parse structured product data, then relevant readable content; use schema-constrained model extraction when needed, keeping evidence excerpts. Tavily Extract is independently configurable. Report blocked/unsupported pages; browser automation is not an initial dependency. Fetching must not expose installation secrets or provide general internal-network access to research URLs.
- **Tool contracts:** Expose typed requirement/clarification, catalogue search, discovery, evidence retrieval, evaluation/comparison, and watch operations. Return structured results, references, gaps and failures. Enforce phase-level tool availability; catalogue writes pass validation and identity resolution. No general SQL tool is exposed to the agent.
- **Research state/context:** Persist authoritative requirements, assumptions, phase, candidates, evidence references, outstanding questions and consumed budget outside the transcript. Assemble bounded model context from these records, recent messages and relevant evidence. Summaries do not override structured requirements. Requirement changes invalidate affected evaluations and reuse unaffected evidence.
- **Ranking:** Retrieval combines exact, lexical and optional semantic candidates; recommendation checks eligibility and verified must-haves before ranking preferences and trade-offs. Models return evidence-linked assessments; code enforces exclusions and assembles ordering. Low price or similarity never compensates for a failed must-have. Uncertain candidates remain separate.
- **Model roles:** Default to one conversational/research model, with optional extraction and embedding overrides. Embeddings remain optional. Check capabilities during setup, record provider/model usage, and do not route to another provider silently.

- **Accepted agent/search design, first technical round:** Use one bounded shopping agent within application-enforced research phases: requirements, catalogue search, gap identification, external research, evaluation, and presentation. Persist progress and allow bounded iteration and clarification. Code enforces permissions, budgets, evidence checks, and allowed transitions.
- **Catalogue retrieval:** Combine exact identifiers and structured filters with full-text/trigram retrieval and optional multilingual semantic retrieval. Merge candidates before evidence-based requirement evaluation. Semantic similarity does not verify exact identity or must-have attributes. Keep lexical search functional without embeddings.
- **Configurable search/retrieval:** Support SearXNG as a self-hostable search option alongside Tavily Search; configure page evidence retrieval independently, including Tavily Extract. Do not silently require a paid discovery provider. Provider selection, fallback, and extraction choices must be visible and configurable. Search results are discovery evidence, not verified offers. Use an optional SearXNG Compose profile or a configured external instance. The built-in retrieval pipeline works without Tavily; paid fallback is opt-in.
- **Evidence sufficiency:** Code checks identity, eligibility, must-have evidence, and freshness; the model assists with subjective suitability and research gaps. Candidate count alone is not proof of sufficient research.
- **Category attributes:** Use an extensible registry of canonical attribute names, types, units, and synonyms. Models may propose mappings; validation controls acceptance. Preserve unfamiliar claims without automatically activating model-created filters. Incomplete structured coverage must not exclude entire categories from discovery.
- **Extension scope correction:** The user withdrew developer-added skills and inbound MCP integrations in Q57. Do not build a skill loader, extension registry, extension configuration, or external MCP client feature for the built-in agent. Ordinary built-in agent instructions and typed shopping tools remain; the outward-facing shopping MCP server remains in scope.

- **Market and release scope:** Netherlands, all product categories, English and Dutch. All three shopping workflows are required for the first public release. Broad category support means flexible evidence handling, not a promise of universal retailer coverage. No imposed delivery deadline exists.
- **Stack and packaging:** Use a TypeScript monorepo with pnpm workspaces, Next.js for the web application and HTTP endpoints, and separate Node.js worker and MCP applications. Use PostgreSQL for the catalogue and durable application state; start with PostgreSQL-backed jobs rather than an additional queue service. Select currently supported versions during implementation.
- **Core engine:** Put shopping operations, input validation, workspace authorization, and provider-independent interfaces in a framework-independent engine. HTTP and MCP are thin adapters. Built-in agent tools call the core directly; external agents use MCP. Direct callers receive the same validation and access enforcement as transport callers.
- **Agent:** Use Vercel AI SDK with typed shopping tools, built-in instructions, authenticated workspace context, structured results, and bounded context management. Persist requirements and result references so summarization preserves constraints and provenance. Retailer content is evidence, not authority to alter instructions or permissions.
- **Workspace boundary:** Private conversations, preferences, credentials, comparisons, research context, watches, and notification settings belong to a workspace. Initially a workspace serves one user. The ownership design must allow multiple workspaces in future hosting without requiring a hosted service at launch.
- **Catalogue boundary:** Hosted workspaces may share public product facts and offers with provenance. Never publish private prompts, preferences, credentials, or watch settings into the shared catalogue. Self-hosted installations maintain independent catalogues.
- **Identity model:** Distinguish product model, exact variant, retailer offer, and timestamped price observation. Compare and monitor exact variants where identity is established; uncertain matches are labelled. A price for another configuration cannot satisfy a watch.
- **Evidence model:** Keep source claims separate from resolved attributes. Preserve source, observation time, and conflicting claims. Search snippets identify candidates rather than verify specifications. Prefer manufacturer evidence for specifications and retailer evidence for offers. Disputed must-have attributes remain unverified.
- **Category model:** Use common fields plus category-specific attributes. Comparison columns follow shopper requirements and distinguish unknown from inapplicable values. Cross-category comparisons are permitted when products address the same intended use.
- **Research:** Extract must-haves and preferences, ask material clarifying questions, expose correctable assumptions, and never silently relax must-haves. Search the catalogue first; reuse adequately sourced specifications, refresh volatile offers, and research externally for missing evidence or insufficient candidates. Fully recommended candidates have verified must-have matches; uncertain ones are separate. Do not fill an arbitrary result quota.
- **Bounded execution:** Configure limits for research time, provider calls, candidates, and spending. Allow cancellation, explicit continuation, progress, and evidence-backed partial results. Persist research and monitoring work so restarts do not lose jobs. Retry temporary failures with limits and expose persistent failures.
- **Offer eligibility:** Business retailers delivering to the Netherlands, EUR prices, new products by default, and refurbished only through explicit preference. Auctions and private sellers are excluded initially.
- **Price basis:** Prefer totals including VAT and known mandatory delivery. Label missing shipping; do not claim cheapest delivery from incomplete totals. Separate conditional discounts and exclude them from default rankings and alerts unless the shopper qualifies. Advertised discounts remain retailer claims unless supported by observed history. Represent monetary values precisely.
- **Delivery location:** Default to Netherlands-wide availability. Request an optional saved postcode only when material to costs or eligibility; share it only with relevant delivery/data providers. A postcode is private shopper information.
- **Watches:** Target an exact offer or established variant, with independent condition and delivery constraints. Execute explicit creation/edit requests and display the result; clarify ambiguity. Require confirmation for bulk deletion or changes affecting multiple watches. Session changes do not silently change watch settings.
- **Threshold semantics:** Target-price alerts fire on threshold crossings, including one notification if a fresh creation-time price already meets the target. Price-drop watches establish the first successful observation as baseline, then compare with the last notified price after notifications, using a configurable minimum decrease. Suppress repeated notifications for the same qualifying price. Seller changes in variant watches preserve constraints.
- **Scheduling:** Check daily by default in Europe/Amsterdam, support configurable daily schedules, quiet hours, and pause/resume. Show last successful check. After downtime, obtain a fresh observation and disclose the gap rather than infer missed prices.
- **Notifications:** Require a fresh successful price observation. Persist an in-app alert immediately; deliver email outside quiet hours and recheck relevance before delayed delivery. Use persistent delivery state and deduplication across retries/restarts. Email failures leave the in-app alert available. Document ambiguous SMTP delivery behavior rather than promising impossible delivery certainty.
- **Provider support:** Select a small tested launch set after a primary-source review of Netherlands coverage, sources, freshness, costs, and limitations. Verify at least one hosted AI provider, a configurable compatible/local-model endpoint, a useful search/data integration, and SMTP. AI capability checks must distinguish model/tool/structured-output support; endpoint compatibility alone is insufficient. External search/data remain independently configured even with local inference.
- **Credentials:** Support installation-administrator keys and optional workspace overrides. Encrypt persisted credentials using an installation secret held outside PostgreSQL. Exclude secrets from model context, browser responses, and diagnostic output. First-run setup provides connection checks and unavailable-workflow status.
- **Spending:** Installation administrators set hard limits; workspace overrides cannot bypass them. Separate interactive research and background monitoring budgets. Pause affected work visibly when limits are reached. Background use of personal keys requires explicit opt-in. Coordinate concurrent work to avoid overspending; document conservative usage estimates where exact pre-call provider costs are unavailable. No silent provider fallback changing cost or data destination.
- **Authentication and MCP:** Require accounts for persisted conversations and watches. Start with email/password and administrator invitations; public registration is off by default. Keep identity implementation replaceable and document administrator recovery. External MCP clients receive scoped workspace access to shopping operations, not provider secrets or administrator settings; implement usable credential expiry/revocation controls during integration work.
- **UI:** Provide chat plus dedicated product, comparison, and watch views, session navigation, research progress, and structured persisted results. Distinguish historical results from fresh offers. Save cross-session preferences only explicitly; expose their application and edit/delete controls.
- **Failure behavior:** Saved conversations, catalogue browsing, comparisons, and watch management remain usable during provider outages. Research clearly reports incompleteness. Failures must not turn missing evidence into invented specifications or prices.
- **Retention:** Make retention configurable. Allow deletion of private sessions, saved preferences, and watches, including dependent private data as appropriate, without deleting independently reusable public facts or independent watches. Retain only evidence excerpts and metadata needed for claims by default, rather than full copied pages.
- **Deployment:** Docker Compose starts the complete application with development and production configurations. Document provider prerequisites, setup, migrations, secrets, HTTPS/network exposure, backup/restore, and recovery. Production-oriented self-hosting does not require a particular cloud vendor.
- **Commercial policy:** Adopt AGPL-3.0-or-later. Keep shopping capabilities available to self-hosters; monetize managed hosting, managed monitoring, and optional included usage. Disclose affiliate links and keep affiliate revenue out of recommendation ranking. Paid hosting and billing implementation are future work.

## Testing Decisions

- **Research quality gate:** Maintain a bilingual evaluation set spanning heterogeneous categories, exact models, vague needs, conflicts and missing evidence. Measure candidate relevance and Dutch/English matching separately from correctness. Check exact variants, evidence-backed must-haves, honest uncertainty, price basis/freshness, appropriate clarification/stopping and bounded usage. All curated safety/correctness scenarios must pass. Establish numerical retrieval-relevance targets from the initial benchmark and document failures rather than inventing quality guarantees.
- **Technical design regression scenarios:** Exercise same-model/different-configuration listings, retailer-specific SKUs, conflicting identifiers, exact/compare/broad completion rules, weak catalogue coverage, six-hour offer expiry, thirty-day specification rechecks, explicit refresh failure, provider cache metadata, fresh-only scheduled observations and each independent research cap including retries/continuation. Verify keyword-only operation without embeddings, SearXNG without Tavily credentials, independently configured Tavily extraction, and no paid fallback unless enabled.

- **Confirmed primary seam:** Test the authenticated shopping engine through its public operations, with real PostgreSQL behavior where persistence, isolation, job recovery, or concurrency matter. This is the shared business-behavior boundary for agent, HTTP, and MCP access.
- **Small additional seams:** Use thin HTTP/MCP contract checks to prove transport schemas, authentication, scope enforcement, and error mapping. Use browser checks only for observable interactive workflows, session navigation, localization, and structured results. Avoid duplicating every shopping rule at every layer.
- **Good tests:** Assert externally visible outcomes, not private method calls, internal prompt wording, table layouts, or component implementation. A meaningful change includes the checks for its new behavior; release checks consolidate rather than postpone verification.
- **Prior art:** The repository has domain and decision documents but no application code or test suite. There are no existing testing seams or comparable tests to extend. All proposed checks must be implemented and their actual results reported later.
- **Research fixtures:** Use recorded provider fixtures for English/Dutch requirements, material clarification, visible assumptions, verified and uncertain matches, insufficient evidence, conflicts, stale prices, heterogeneous categories, cancellation, continuation, and exhausted budgets. Do not assert one exact model-generated paragraph as correctness.
- **Catalogue fixtures:** Include different configurations of the same model, ambiguous identities, repeat ingestion, cross-category comparisons, missing/inapplicable attributes, VAT/shipping/conditional discounts, refurbished filtering, Netherlands delivery/postcodes, and source disagreement. Verify exact-variant recommendations and watches never silently use a cheaper different configuration.
- **Monitoring fixtures:** Control time and provider observations to prove initial target satisfaction, threshold crossings, first baseline, minimum decreases, last-notified comparisons, duplicate-price suppression, seller constraints, daily Amsterdam schedules, quiet hours, delayed-email relevance, pause/resume, missed-check gaps, and failed fresh checks producing no alert.
- **Recovery and delivery:** Restart workers during persisted jobs and notification delivery; exercise bounded retries and concurrent processing. Verify durable progress, budget enforcement, application-level deduplication, visible failures, and in-app alerts surviving email failure. Document SMTP uncertainty after ambiguous delivery outcomes.
- **Access and secrets:** Exercise two workspace identities through core and transports, including tampered identifiers, unauthorized tool calls, scoped clients, expired/revoked access, and direct core calls. Verify secrets do not enter model payloads or browser output, retrieved instructions cannot expand authority, and private context never becomes public catalogue data.
- **Budget/provider checks:** Verify separate budgets, concurrent usage, explicit personal-key consent, missing capabilities, configured fallback, provider outages, and visible pauses. Use simulated paid-provider responses for repeatability; keep live spending bounded.
- **End-to-end acceptance:** Demonstrate needs-to-shortlist, side-by-side comparison, and offer-to-watch-to-notification in both languages, with saved sessions and external MCP access. Demonstrate full development/production Compose startup, migration, and backup/restore behavior. A handful of heterogeneous fixtures demonstrates flexible category handling without claiming universal coverage.
- **Live checks:** Run separately configured smoke tests against the selected hosted AI, compatible/local AI route, search/data integration, and SMTP when credentials/endpoints are supplied. Do not commit secrets or invent successful live results. Document verified coverage, numeric defaults, observed limits, and remaining blockers.

## Out of Scope

- Carts, checkout, payments to retailers, and autonomous purchasing.
- Markets outside the Netherlands or a worldwide retailer guarantee.
- A launch restriction to one product category.
- Auctions, private-seller listings, and refurbished offers without explicit shopper preference.
- Broad requirement watches such as any suitable dishwasher below a budget.
- Coupon discovery, automatic coupon redemption, back-in-stock alerts, and broad saved-search monitoring.
- Unrestricted scraping of every retailer as a launch dependency.
- Claims that every AI provider/model or compatible endpoint supports every tool and workflow.
- Fabricated price history, guaranteed detection of changes between daily checks, or inferred prices during downtime.
- Cloud-hosted deployment, subscriptions, billing, and paid-service infrastructure in this release.
- Developer-added skill loaders, extension registries, and external MCP connections for the built-in agent, withdrawn in Q57. This does not exclude the application’s outward-facing shopping MCP server.
- Feature exclusivity that withholds agreed shopping capabilities from self-hosters.

## Further Notes

- **Technical design accepted:** The user accepted the focused agent/search design through Q63. This specification includes the agreed contracts and defaults and is ready-for-agent for implementation task breakdown. No application implementation or live provider validation has occurred.

- The product-requirements interview is complete: the user accepted the final stack, delivery-location, baseline, scheduling, provider-selection, and handoff recommendations. This spec synthesizes those decisions without requiring a new product interview or a Specshape workflow.
- Provider/library versions and concrete library choices require current primary-source verification during implementation. Search adapters and initial research/freshness defaults are selected above; monetary/token ceilings, retention settings, model choices and performance tuning require configuration or calibration with documented rationale. No actual monthly budget, initial user count, or performance target was supplied.
- This is a new product: no existing application behavior, implemented provider support, automated test results, or deployment readiness is claimed.
- The chosen licence policy was checked against GNU AGPLv3 section 13 during the interview. Its source is the GNU Project’s licence text: https://www.gnu.org/licenses/agpl-3.0.html#section13 . The licence and applicable notices must be supplied with implementation.
- Local and GitHub publication represent the same specification. Record the GitHub issue URL locally after publication and keep triage status synchronized in both locations. Publication does not mean the application has been built.
