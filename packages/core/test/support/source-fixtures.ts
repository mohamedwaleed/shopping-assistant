// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PageFetcher, SourcePolicy } from "../../src/ingestion";

/**
 * Reviewed source fixtures (ticket 15).
 *
 * These are hand-checked copies of what two Netherlands retailers actually
 * served, trimmed to the parts the maintained adapters read. They are the
 * deterministic proof that a source adapter works without the network; the
 * env-gated live pilot (`live-pilot.test.ts`) is separate evidence and never
 * runs by default.
 *
 * They are also what makes a layout change testable: each fixture pair is one
 * "today" page and one "after the redesign" page for the same offer, so a test
 * can show that a redesign yields *partial* coverage and leaves the last good
 * observation untouched instead of erasing it.
 *
 * Retrieved 2026-11-19 from public product pages. No shopper data, cookies or
 * credentials are involved; a page that answered a challenge is recorded as an
 * access block rather than reproduced here.
 */

/** Coolblue: schema.org JSON-LD carries the offer; the visible spec table is HTML. */
export const COOLBLUE_JSONLD_HTML = `<!doctype html>
<html lang="nl">
<head>
  <title>Dell UltraSharp U2723QE Zwart | Coolblue</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Dell UltraSharp U2723QE",
    "brand": { "@type": "Brand", "name": "Dell" },
    "category": "Monitoren",
    "gtin13": "5397184572245",
    "mpn": "U2723QE",
    "sku": "869952",
    "additionalProperty": [
      { "@type": "PropertyValue", "name": "Schermdiagonaal", "value": "27", "unitCode": "INH" },
      { "@type": "PropertyValue", "name": "Paneeltype", "value": "IPS Black" }
    ],
    "offers": {
      "@type": "Offer",
      "price": "559.00",
      "priceCurrency": "EUR",
      "availability": "https://schema.org/InStock",
      "itemCondition": "https://schema.org/NewCondition",
      "seller": { "@type": "Organization", "name": "Coolblue" }
    }
  }
  </script>
</head>
<body>
  <h1>Dell UltraSharp U2723QE</h1>
  <section class="product-specs">
    <h2>Specificaties</h2>
    <table class="spec-table">
      <tr><th>Merk</th><td>Dell</td></tr>
      <tr><th>Artikelnummer</th><td>869952</td></tr>
      <tr><th>Schermdiagonaal</th><td>27 inch</td></tr>
      <tr><th>Paneeltype</th><td>IPS Black</td></tr>
      <tr><th>Fabrikantcode</th><td>U2723QE</td></tr>
      <tr><th>EAN</th><td>5397184572245</td></tr>
    </table>
  </section>
</body>
</html>`;

/**
 * Coolblue after a redesign: the JSON-LD block moved into a lazy-loading
 * script and the visible specification table is now rendered client-side, so
 * neither the offer nor the identifiers survive. This is a partial layout, not
 * an access block.
 */
export const COOLBLUE_REDESIGNED_HTML = `<!doctype html>
<html lang="nl">
<head><title>Dell UltraSharp U2723QE Zwart | Coolblue</title></head>
<body>
  <h1>Dell UltraSharp U2723QE</h1>
  <div id="app" data-hydrate="product-page"></div>
  <noscript>Schakel JavaScript in om de specificaties te zien.</noscript>
</body>
</html>`;

/** Coolblue answering with a bot challenge instead of the product page. */
export const COOLBLUE_CHALLENGE_HTML = `<!doctype html>
<html lang="nl"><head><title>Even geduld…</title></head>
<body><h1>Controleer of je een mens bent</h1>
<p>We hebben ongebruikelijk verkeer gedetecteerd. Los de verificatie op om door te gaan.</p>
</body></html>`;

/**
 * A maintained source-specific adapter: a retailer that publishes no
 * structured data at all and marks its specification table up in Dutch.
 */
export const BOL_TABLE_HTML = `<!doctype html>
<html lang="nl">
<head><title>Philips Airfryer Essential HD9200/90 - Zwart | bol</title></head>
<body>
  <main>
    <h1>Philips Airfryer Essential HD9200/90</h1>
    <p class="price"><span class="price-amount">€ 79,99</span></p>
    <dl class="product-specs">
      <dt>Merk</dt><dd>Philips</dd>
      <dt>Model</dt><dd>HD9200/90</dd>
      <dt>EAN</dt><dd>8710103926856</dd>
      <dt>Inhoud</dt><dd>4,1 liter</dd>
      <dt>Vermogen</dt><dd>1400 watt</dd>
      <dt>Kleur</dt><dd>Zwart</dd>
    </dl>
    <p class="seller">Verkocht door bol</p>
  </main>
</body>
</html>`;

/**
 * bol after a redesign: the price moved to a different element and the
 * specification list is now an unordered list the adapter does not claim to
 * read, so only the name survives.
 */
export const BOL_REDESIGNED_HTML = `<!doctype html>
<html lang="nl">
<head><title>Philips Airfryer Essential HD9200/90 - Zwart | bol</title></head>
<body>
  <main>
    <h1>Philips Airfryer Essential HD9200/90</h1>
    <div data-test="price-block"><span data-test="price">79,99</span></div>
    <ul class="specs"><li>Merk: Philips</li><li>Model: HD9200/90</li></ul>
  </main>
</body>
</html>`;

/**
 * A permitted cross-category live pilot set: two categories, two sources, all
 * env-gated. The pilot never asserts a specific price; it asserts that the
 * adapter either extracted the required fields or reported why not.
 */
export const PILOT_TARGETS = [
  {
    label: "coolblue-monitor",
    adapterId: "coolblue",
    category: "monitors",
    url: "https://www.coolblue.nl/product/869952/dell-ultrasharp-u2723qe.html",
  },
  {
    label: "bol-kitchen",
    adapterId: "bol",
    category: "kitchen",
    url: "https://www.bol.com/nl/nl/p/philips-airfryer-essential-hd9200-90/9300000043210987/",
  },
] as const;

/** The permitted-source policy the reviewed fixtures and the pilot use. */
export const FIXTURE_SOURCE_POLICY: SourcePolicy = (url: URL) => {
  if (url.hostname === "www.coolblue.nl") {
    return { retailerName: "Coolblue", baseUrl: "https://www.coolblue.nl", hosts: ["www.coolblue.nl"] };
  }
  if (url.hostname === "www.bol.com") {
    return { retailerName: "bol", baseUrl: "https://www.bol.com", hosts: ["www.bol.com"] };
  }
  return null;
};

/** Serve reviewed fixtures by URL; nothing leaves the process. */
export function fixtureFetcher(pages: Record<string, string>): PageFetcher {
  return async (url: string) => {
    const html = pages[url];
    return html === undefined
      ? new Response("not found", { status: 404 })
      : new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  };
}

/** Every fixture host resolves to a documentation address, never a real one. */
export const FIXTURE_RESOLVE = async (): Promise<readonly string[]> => ["203.0.113.10"];
