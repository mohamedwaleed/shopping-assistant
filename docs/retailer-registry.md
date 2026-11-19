# Netherlands retailer retrieval notes

Status: reference notes, researched 2026-11-17 and retrieval-checked 2026-11-19. This is a knowledge document, not a configured feature: nothing here is seeded, granted permission or fetchable by the application. Ticket 07 built a registry and was withdrawn; use these notes when ingestion is designed.

## Purpose

Record what is known about retrieving product data from Netherlands retailers, so
that ingestion design starts from measured behaviour rather than assumptions.
Nothing in this document is configured in the application: there is no source
registry, no seeded list and no granted permission. Domain or language alone never
verifies Netherlands delivery, and a retailer appearing here is neither a
recommendation nor permission to fetch it.

## Questions ingestion must answer per retailer

- Retailer/platform identity: canonical domains, category coverage and
  direct/marketplace/mixed classification where established.
- Acquisition: which methods actually work, what the terms or permission evidence
  says, request/concurrency limits, and any parser or feed configuration.
- Netherlands eligibility evidence: delivery-policy URL, when it was last reviewed
  and any restrictions. Offer-specific seller, variant, postcode and delivery
  verification still apply.
- Operational state: last successful check, fetch/extraction health, failure reason
  and supported fields. Permission and technical health are separate facts.
- Actual offer sellers are separate from hosting platforms. A marketplace domain
  does not prove each business seller's delivery eligibility, terms or condition.

## Candidate list

The table below is a research record of retailers considered during discovery. It is
not a seed list and must not be loaded into the application.

Use these notes to prioritize category-relevant source discovery and to explain which
sources were examined, blocked or not checked. Do not limit every query to this list
and do not claim market exhaustiveness. Source popularity does not override
requirement-fit ranking. Crawling rights are unknown until reviewed; this list does
not declare an API, feed or partnership available.

## Researched candidates

Official pages were inspected to establish a relevant storefront/category presence. This was a documentation/discovery check, not a repeated scraping or offer-accuracy pilot.

| Candidate | Initial category role | Official source | Observation / onboarding caveat |
|---|---|---|---|
| bol | Broad catalogue, books, household and other categories | https://www.bol.com/nl/nl/ | Marketplace seller identity must be resolved per offer. |
| Amazon.nl | Broad-marketplace discovery candidate | https://www.amazon.nl/ | Check returned a robot/JavaScript verification page; no working extraction claimed. |
| Coolblue | Electronics, appliances, household | https://www.coolblue.nl/ | Product-level variant, offer and acquisition tests still needed. |
| MediaMarkt | Electronics and appliances | https://www.mediamarkt.nl/nl/ | Marketplace FAQ confirms third-party offer context needs separate seller checks: https://www.mediamarkt.nl/nl/service/klantenservice/veelgestelde-vragen-marketplace . |
| ALTERNATE | Computing, components and technology | https://www.alternate.nl/ | Storefront exposes a JavaScript notice; extraction not established. |
| Megekko | Computing, components and peripherals | https://www.megekko.nl/ | Category/product offer tests still needed. |
| IKEA Netherlands | Furniture, lighting, home | https://www.ikea.com/nl/nl/ | Variant and postcode/delivery-cost evaluation still needed. |
| GAMMA | DIY, tools and garden | https://www.gamma.nl/ | Conditional loyalty offers and delivery require offer-specific checks. |
| HORNBACH | DIY, tools and garden | https://www.hornbach.nl/ | Storefront returned cookie/JavaScript and location context; extraction not established. |
| Decathlon Netherlands | Sports and outdoor | https://www.decathlon.nl/ | New-condition defaults and seller/delivery context must be validated. |
| Zalando Netherlands | Clothing, footwear and accessories | https://www.zalando.nl/ | Size/colour variants and seller context require validation. |
| Douglas Netherlands | Beauty, perfume and cosmetics | https://www.douglas.nl/nl | Pack size and conditional promotions require validation. |
| zooplus Netherlands | Pet supplies and accessories | https://www.zooplus.nl/ | Pack size, recurring-order discounts and shipping require validation. |
| Babypark | Baby equipment, nursery and related products | https://www.babypark.nl/ | Product bundles/variants and delivery require validation. |

An earlier draft recommended a pilot of Coolblue, bol, IKEA, GAMMA and Decathlon. The retrieval check below shows bol, GAMMA and Decathlon blocked, so that pilot is not viable. Start from the sources that answer a live fetch and add specialists discovered through demand rather than hard-coding a closed market.

## Retrieval check (2026-11-19)

Each candidate's `robots.txt` and a live product-page request were checked with a
non-browser agent. This records what the servers actually did; it is not a legal
opinion and does not grant permission. Every seeded source still ships with
`permission: unknown` until an administrator establishes it.

| Candidate | robots.txt | Live fetch | Observation |
|---|---|---|---|
| Megekko | `Allow: /`, cart/account disallowed | 200, real content | Fetchable as-is. |
| ALTERNATE | Explicitly allows `/llms.txt` | 200 | Publishes an `llms.txt` with direct product links. |
| Babypark | Permissive | 200 | Product sitemaps published. |
| zooplus | Rules for OAI-SearchBot/ClaudeBot | 200 | Explicit AI-crawler governance section. |
| Coolblue | Allow, product sitemaps published | 307 on an invalid id | Sitemaps are the useful entry point. |
| MediaMarkt | Mostly permissive, sitemap index | not tested | |
| IKEA | Bot-specific rules | not tested | Needs per-path review. |
| Amazon.nl | Permissive | 200 **captcha page** | Returns a 4 KB challenge, not content. Treat as blocked. |
| Decathlon | Disallows `/api/*` and many query parameters | 403 | Blocked at the edge. |
| bol | Allow, sitemaps | **403** on a product page | Aggressive bot protection. |
| GAMMA | — | **429** security checkpoint | Vercel challenge on every attempt. |
| Zalando | — | **403** challenge page | |
| Douglas | — | **403** (short UA), 400 otherwise | |
| HORNBACH | Returns an HTML challenge, not robots | not tested | |

APIs: bol operates a Retailer API (selling partners) and is retiring its open
catalogue API; Coolblue's Marketplace API is for selling on Coolblue, not for
reading its catalogue. Neither is available to a self-hoster. Other JSON
services found for these retailers are third-party scrapers, not official.
Sitemaps list URLs; they are discovery input, not product data.

Consequence: the pilot recommendation above is not currently achievable. Prefer
the sources marked fetchable, and treat the rest as discovery hints whose pages
cannot be retrieved until their access changes.
