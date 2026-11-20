// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  extractionPrompt,
  readableContent,
  verifyModelReading,
  type ReadableContent,
} from "../src/ingestion/readable-extraction";
import { BOL_REDESIGNED_HTML } from "./support/source-fixtures";

// Readable-content extraction is the fallback for a permitted page that has no
// structured data and no maintained adapter. What matters is observable: the
// text a model would be shown, where each line came from, and that a model
// reading which the page does not support is discarded instead of recorded.

const BOL_TEXT = `<html><body>
  <h1>Philips Airfryer Essential HD9200/90</h1>
  <p>De Philips Airfryer Essential bak <b>4,1 liter</b> in een keer.</p>
  <p>Prijs: &euro; 79,99 (EUR)</p>
  <dl class="specs"><dt>EAN</dt><dd>8710103926851</dd><dt>Model</dt><dd>HD9200/90</dd></dl>
  <script>window.tracking = "do not read me";</script>
  <style>.price { color: red }</style>
</body></html>`;

describe("readable content", () => {
  it("keeps readable lines with the page region each came from", () => {
    const content = readableContent(BOL_TEXT);

    expect(content.empty).toBe(false);
    expect(content.lines.map((line) => line.text)).toEqual([
      "Philips Airfryer Essential HD9200/90",
      "De Philips Airfryer Essential bak 4,1 liter in een keer.",
      "Prijs: € 79,99 (EUR)",
      "EAN",
      "8710103926851",
      "Model",
      "HD9200/90",
    ]);
    // Script and style contents are never readable content.
    expect(content.lines.map((line) => line.text).join(" ")).not.toContain("do not read me");
    expect(content.lines[0]).toEqual({ selector: "h1", text: "Philips Airfryer Essential HD9200/90" });
    expect(content.lines[4]).toEqual({ selector: "dd:contains", text: "8710103926851" });
  });

  it("reports a page with no readable body text as empty", () => {
    const content = readableContent(BOL_REDESIGNED_HTML.replace("<h1>", "<script>x</script><div>").replace("</h1>", "</div>"));
    expect(content.empty).toBe(false);
    // A page that really has no text at all is empty, not silently successful.
    expect(readableContent("<html><body><script>1</script></body></html>")).toEqual({ lines: [], empty: true });
  });

  it("tells the model to answer only from the numbered lines", () => {
    const content = readableContent(BOL_TEXT);
    const prompt = extractionPrompt(content, "https://www.bol.com/nl/nl/p/philips-airfryer/9300000043210987/");

    expect(prompt).toContain("[2] Prijs: € 79,99 (EUR)");
    expect(prompt).toContain("never supply a value from general knowledge");
    expect(prompt).toContain("Required fields: name, price, currency, gtin.");
  });
});

describe("evidence-linked model extraction", () => {
  const content: ReadableContent = readableContent(BOL_TEXT);

  it("accepts a reading the page supports and links each value to its line", () => {
    const extraction = verifyModelReading(
      {
        fields: {
          name: "Philips Airfryer Essential HD9200/90",
          price: "79.99",
          currency: "EUR",
          gtin: "8710103926851",
          mpn: "HD9200/90",
        },
        // The model points at the lines it read: name on line 0, price on line 2
        // (the line states "79,99"; the value itself must still appear).
        evidence: { name: 0, price: 2, currency: 2, gtin: 4, mpn: 6 },
        attributes: { Model: "HD9200/90" },
      },
      content,
    );

    expect(extraction.fields).toEqual({
      name: "Philips Airfryer Essential HD9200/90",
      price: "79.99",
      currency: "EUR",
      gtin: "8710103926851",
      mpn: "HD9200/90",
    });
    expect(extraction.evidence).toContainEqual({ field: "gtin", selector: "dd:contains", value: "8710103926851" });
    expect(extraction.requiredCoverage).toEqual({
      present: ["name", "price", "currency", "gtin"],
      missing: [],
    });
  });

  it("never accepts a required field the page does not state", () => {
    const extraction = verifyModelReading(
      {
        fields: {
          name: "Philips Airfryer Essential HD9200/90",
          price: "69.99",
          gtin: "8710103926851",
        },
        // The model cites a line for a price the page never states, and gives
        // no evidence at all for the currency.
        evidence: { name: 0, price: 2, gtin: 4 },
      },
      content,
    );

    expect(extraction.fields).toEqual({
      name: "Philips Airfryer Essential HD9200/90",
      gtin: "8710103926851",
    });
    expect(extraction.requiredCoverage).toEqual({
      present: ["name", "gtin"],
      missing: ["price", "currency"],
    });
  });

  it("drops a value whose cited line is not evidence for it", () => {
    const extraction = verifyModelReading(
      { fields: { price: "79.99", gtin: "8710103926851" }, evidence: { price: 0, gtin: 0 } },
      content,
    );
    expect(extraction.fields).toEqual({});
    expect(extraction.requiredCoverage.missing).toEqual(["name", "price", "currency", "gtin"]);
  });

  it("rejects an invalid identifier or currency rather than normalizing it", () => {
    const extraction = verifyModelReading(
      {
        fields: { gtin: "87101039268", currency: "euro", price: "79,99" },
        evidence: { gtin: 4, currency: 2, price: 2 },
      },
      content,
    );
    expect(extraction.fields).toEqual({});
  });
});
