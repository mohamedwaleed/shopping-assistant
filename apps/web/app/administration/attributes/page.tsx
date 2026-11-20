// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { resolveLang } from "@/lib/i18n";
import { AttributeReviewForm } from "./attribute-review-form";
import { SourceCoverageForm } from "./source-coverage-form";

/** Review is intentionally a narrow administrator queue, never a bulk rewrite. */
export default async function AttributeReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const lang = resolveLang((await searchParams).lang);
  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);
  const result = await getCore().catalogue.listAttributeReviews(identity.trusted.principal);
  if (!result.ok) return <main className="content"><h1>{lang === "nl" ? "Attribuutcontrole" : "Attribute review"}</h1><p role="alert">{lang === "nl" ? "Alleen installatiebeheerders kunnen claims beoordelen." : "Only installation administrators can review claims."}</p></main>;
  return <main className="content"><h1>{lang === "nl" ? "Attribuutcontrole" : "Attribute review"}</h1><p className="muted">{lang === "nl" ? "Onopgeloste bronclaims blijven zichtbaar totdat u ze valideert of afwijst." : "Unresolved source claims remain visible until you validate or reject them."}</p><SourceCoverageForm lang={lang} />{result.value.length === 0 ? <p>{lang === "nl" ? "Geen claims wachten op beoordeling." : "No claims need review."}</p> : result.value.map((claim) => <AttributeReviewForm claim={claim} key={claim.id} lang={lang} />)}</main>;
}
