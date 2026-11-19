// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AttributeReview } from "@shopping/core";

export function AttributeReviewForm({ claim, lang }: { claim: AttributeReview; lang: "en" | "nl" }) {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const router = useRouter();
  async function submit(canonicalKey: string | null) {
    const response = await fetch("/api/administration/attributes", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimId: claim.id, canonicalKey }) });
    if (!response.ok) { setMessage(lang === "nl" ? "De claim kon niet worden gevalideerd met dit type of deze eenheid." : "This claim is not compatible with that type or unit."); return; }
    router.refresh();
  }
  return <article className="panel review-card"><strong>{claim.rawName}</strong><p className="muted">{String(claim.value)} · <a href={claim.sourceUrl} target="_blank" rel="noreferrer">source evidence</a></p><label>Canonical key<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="power_w" /></label><div className="review-actions"><button className="btn-primary" type="button" disabled={!key} onClick={() => submit(key)}>{lang === "nl" ? "Valideren" : "Validate"}</button><button className="btn-quiet" type="button" onClick={() => submit(null)}>{lang === "nl" ? "Afwijzen" : "Reject"}</button></div>{message && <p role="alert">{message}</p>}</article>;
}
