// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  adapterFor,
  adaptersForHost,
  MAINTAINED_ADAPTERS,
  REQUIRED_PRODUCT_FIELDS,
  type AdapterPage,
} from "../src/ingestion/source-adapters";
import { BOL_REDESIGNED_HTML, BOL_TABLE_HTML, COOLBLUE_JSONLD_HTML } from "./support/source-fixtures";

// A maintained source adapter turns one retailer's reviewed page layout into
// the same normalized shape. Everything a caller can observe is here: which
// fields it found, which required fields it did not, and which adapter version
// produced the reading — never a guessed value for a field it could not find.

function page(html: string, url = "https://www.coolblue.nl/product/1"): AdapterPage {
  return { url, html };
}

describe("maintained source adapters", () => {
  it("declares a stable id and version for every maintained adapter", () => {
    const declarations = MAINTAINED_ADAPTERS.map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      hosts: adapter.hosts,
      required: adapter.requiredFields,
    }));
    expect(declarations).toEqual([
      {
        id: "coolblue",
        version: "2026.11.1",
        hosts: ["www.coolblue.nl"],
        required: ["name", "price", "currency", "gtin"],
      },
      {
        id: "bol",
        version: "2026.11.1",
        hosts: ["www.bol.com"],
        required: ["name", "price", "currency", "gtin"],
      },
    ]);
  });

  it("reads the structured offer and the visible specification table together", () => {
    const adapter = adapterFor(new URL("https://www.coolblue.nl/product/869952/dell-ultrasharp-u2723qe.html"));
    expect(adapter?.id).toBe("coolblue");
    if (!adapter) return;

    const reading = adapter.read(page(COOLBLUE_JSONLD_HTML));

    // The offer comes from JSON-LD; the identifier the adapter requires is
    // taken from it, and the visible table supplies the Dutch specification
    // names the JSON-LD omits.
    expect(reading.fields).toEqual({
      name: "Dell UltraSharp U2723QE",
      manufacturer: "Dell",
      category: "Monitoren",
      gtin: "5397184572244",
      mpn: "U2723QE",
      sku: "869952",
      price: "559.00",
      currency: "EUR",
      seller: "Coolblue",
      condition: "new",
    });
    expect(reading.attributes).toMatchObject({
      "Schermdiagonaal": "27 inch",
      "Paneeltype": "IPS Black",
    });
    expect(reading.evidence).toContainEqual({
      field: "price",
      selector: "script[type=application/ld+json] offers.price",
      value: "559.00",
    });
    expect(reading.evidence).toContainEqual({
      field: "attribute.Paneeltype",
      selector: "table.spec-table tr:nth-of-type(4) td",
      value: "IPS Black",
    });
    expect(reading.requiredCoverage).toEqual({ present: REQUIRED_PRODUCT_FIELDS, missing: [] });
  });

  it("reads a source with no structured data through its maintained table adapter", () => {
    const adapter = adapterFor(new URL("https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/"));
    expect(adapter?.id).toBe("bol");
    if (!adapter) return;

    const reading = adapter.read(page(BOL_TABLE_HTML, "https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/"));

    // Dutch decimal comma and euro sign are normalized, never passed through.
    expect(reading.fields).toMatchObject({
      name: "Philips Airfryer Essential HD9200/90",
      manufacturer: "Philips",
      gtin: "8710103926851",
      mpn: "HD9200/90",
      price: "79.99",
      currency: "EUR",
      seller: "bol",
    });
    expect(reading.attributes).toMatchObject({
      "Inhoud": "4,1 liter",
      "Vermogen": "1400 watt",
      "Kleur": "Zwart",
    });
    expect(reading.requiredCoverage.missing).toEqual([]);
  });

  it("reports the required fields a layout change removed instead of guessing them", () => {
    const adapter = adapterFor(new URL("https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/"));
    if (!adapter) throw new Error("bol adapter must be maintained");

    const reading = adapter.read(page(BOL_REDESIGNED_HTML, "https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/"));

    expect(reading.fields).toMatchObject({ name: "Philips Airfryer Essential HD9200/90" });
    expect(reading.fields.price).toBeUndefined();
    expect(reading.fields.gtin).toBeUndefined();
    expect(reading.requiredCoverage).toEqual({
      present: ["name"],
      missing: ["price", "currency", "gtin"],
    });
  });

  it("claims only the hosts it maintains", () => {
    expect(adaptersForHost("www.coolblue.nl").map((adapter) => adapter.id)).toEqual(["coolblue"]);
    expect(adapterFor(new URL("https://shop.example.test/product"))).toBeNull();
    expect(adapterFor(new URL("https://www.coolblue.nl.evil.test/product"))).toBeNull();
  });
});
