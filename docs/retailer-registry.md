# Netherlands retailer registry

Status: proposed registry operating model and starter candidates, researched 2026-11-17. Retailer-specific ingestion permission, live offer eligibility and adapter coverage are not established by this document. Knex is explicitly selected for database access; the application has not been implemented.

## Purpose

Keep an installation-level registry in PostgreSQL, accessed through Knex, for known retailer/platform identities and source capabilities. It seeds category-targeted discovery without pretending to enumerate all Netherlands offers. All categories remain eligible. Search can discover additional sources; domain/language alone never verifies Netherlands delivery. Registry inclusion is neither a recommendation endorsement nor permission to scrape.

## Logical records (not SQL schema)

- Retailer/platform identity: stable identifier, display name, verified canonical domains, category coverage and direct/marketplace/mixed classification where established.
- Acquisition configuration per source: allowed methods, applicable terms/permission evidence, request/concurrency limits, parser/adapter identifier/version and optional feed configuration.
- Netherlands eligibility evidence: delivery-policy URL, last reviewed time and restrictions. Offer-specific seller, variant, postcode and delivery verification still apply.
- Operational state: discovery enabled separately from ingestion enabled; last successful check, fetch/extraction health, failure reason and supported fields/capabilities. Use explicit candidate/reviewed/supported/paused states without conflating permissions with technical health.
- Actual offer sellers are separate from hosting platforms. A marketplace domain does not prove each business seller's delivery eligibility, terms or condition.

## Maintenance proposal

Ship version-controlled starter reference entries with stable identifiers, load them idempotently and retain administrator edits during updates. PostgreSQL is the live source of registry state. Installation administrators can add/pause sources and update acquisition policy through the planned admin surface; credentials remain protected. New domains discovered during research begin as candidates rather than silently gaining unrestricted acquisition privileges. Validated product admission within supported source rules remains automatic as already agreed.

Use the registry to prioritize category-relevant source discovery and expose which sources were examined, blocked or not checked. Do not limit every query to the seed list and do not claim market exhaustiveness. Source popularity and affiliate revenue do not override requirement-fit ranking. Initial shipping/crawling rights are unknown until reviewed; this list does not declare an API, feed or partnership available.

## Proposed initial 14 candidates

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

Recommended pilot: a cross-category subset such as Coolblue, bol, IKEA, GAMMA and Decathlon, subject to source-specific acquisition review. This prioritizes integration validation, not a category restriction on the product. Add other specialists discovered through demand rather than hard-coding a closed market.

## Knex integration references

- Knex uses the pg driver for PostgreSQL: https://knexjs.org/guide/ .
- Queries, transactions and raw parameter bindings: https://knexjs.org/guide/query-builder.html , https://knexjs.org/guide/transactions.html , https://knexjs.org/guide/raw.html .
- Application migration tooling: https://knexjs.org/guide/migrations.html .
- Better Auth documents a custom database adapter interface, not a verified native Knex adapter: https://better-auth.com/docs/guides/create-a-db-adapter . Adapter behavior and atomicity require implementation tests.
