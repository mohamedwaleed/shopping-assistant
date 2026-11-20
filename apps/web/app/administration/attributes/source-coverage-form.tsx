// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";
import type { SourceCoverage } from "@shopping/core";

type Lang = "en" | "nl";

const COPY = {
  en: {
    title: "Source coverage",
    intro: "Submit a permitted product URL to see what its extraction covers before anything is admitted.",
    label: "Product URL",
    submit: "Check coverage",
    working: "Checking…",
    failed: "That URL could not be checked.",
    outcome: "Outcome",
    retailer: "Retailer",
    finalUrl: "Final URL",
    name: "Name",
    price: "Price and currency",
    identifier: "Reliable identifier",
    retailerSku: "Retailer SKU (retailer-local)",
    seller: "Seller",
    attributes: "Attribute claims",
    accepted: "accepted",
    unresolved: "unresolved",
    unknown: "Unknown to the vocabulary",
    lastSuccess: "Last successful check",
    lastFailure: "Last failed check",
    never: "Never",
  },
  nl: {
    title: "Dekking van de bron",
    intro: "Voer een toegestane product-URL in om te zien wat de extractie dekt voordat er iets wordt opgenomen.",
    label: "Product-URL",
    submit: "Dekking controleren",
    working: "Controleren…",
    failed: "Die URL kon niet worden gecontroleerd.",
    outcome: "Uitkomst",
    retailer: "Winkel",
    finalUrl: "Eind-URL",
    name: "Naam",
    price: "Prijs en valuta",
    identifier: "Betrouwbare identificatie",
    retailerSku: "Winkel-SKU (winkelspecifiek)",
    seller: "Verkoper",
    attributes: "Attribuutclaims",
    accepted: "geaccepteerd",
    unresolved: "onopgelost",
    unknown: "Onbekend in het vocabulaire",
    lastSuccess: "Laatste geslaagde controle",
    lastFailure: "Laatste mislukte controle",
    never: "Nooit",
  },
} as const;

function present(value: string | null, fallback: string): string {
  return value ?? fallback;
}

export function SourceCoverageForm({ lang }: { lang: Lang }) {
  const copy = COPY[lang];
  const [url, setUrl] = useState("");
  const [report, setReport] = useState<SourceCoverage | null>(null);
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);

  async function submit() {
    setWorking(true);
    setMessage("");
    setReport(null);
    const response = await fetch("/api/catalogue/coverage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    setWorking(false);
    if (!response.ok) {
      setMessage(copy.failed);
      return;
    }
    setReport((await response.json()) as SourceCoverage);
  }

  return (
    <section className="panel">
      <h2>{copy.title}</h2>
      <p className="muted">{copy.intro}</p>
      <label>
        {copy.label}
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
      </label>
      <div className="review-actions">
        <button className="btn-primary" type="button" disabled={!url || working} onClick={submit}>
          {working ? copy.working : copy.submit}
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
      {report && (
        <div className="attr-grid">
          <div className="attr">
            <div className="k">{copy.outcome}</div>
            <div className="v">{report.outcome}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.retailer}</div>
            <div className="v">{present(report.retailerName, "—")}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.finalUrl}</div>
            <div className="v">{present(report.finalUrl, "—")}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.name}</div>
            <div className="v">{report.fields.name ? "✓" : "—"}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.price}</div>
            <div className="v">{report.fields.price && report.fields.currency ? "✓" : "—"}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.identifier}</div>
            <div className="v">{present(report.fields.identifier, "—")}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.retailerSku}</div>
            <div className="v">{present(report.fields.retailerSku, "—")}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.seller}</div>
            <div className="v">{present(report.fields.seller, "—")}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.attributes}</div>
            <div className="v">
              {report.attributes.declared} · {report.attributes.accepted} {copy.accepted} ·{" "}
              {report.attributes.unresolved} {copy.unresolved}
            </div>
          </div>
          <div className="attr">
            <div className="k">{copy.lastSuccess}</div>
            <div className="v">{present(report.lastSuccessAt, copy.never)}</div>
          </div>
          <div className="attr">
            <div className="k">{copy.lastFailure}</div>
            <div className="v">
              {report.lastFailureAt
                ? `${report.lastFailureAt} (${present(report.lastFailureClassification, "—")})`
                : copy.never}
            </div>
          </div>
        </div>
      )}
      {report && report.attributes.unknown.length > 0 && (
        <p className="muted">
          {copy.unknown}: {report.attributes.unknown.join(", ")}
        </p>
      )}
    </section>
  );
}
