// SPDX-License-Identifier: AGPL-3.0-or-later
import { notFound, redirect } from "next/navigation";
import type { VariantOfferDetail } from "@shopping/core";
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { dictionaries, resolveLang, type Lang } from "@/lib/i18n";
import { formatMoney, formatObservedAt } from "@/lib/format";
import { StudioShell } from "@/app/studio-shell";

// Attribute keys rendered with English/Dutch labels; unknown attributes fall
// back to a readable version of the raw key.
const ATTRIBUTE_LABELS: Record<string, Record<Lang, string>> = {
  colour: { en: "Colour", nl: "Kleur" },
  power_w: { en: "Power", nl: "Vermogen" },
  screen_size_inch: { en: "Screen size", nl: "Schermgrootte" },
  resolution: { en: "Resolution", nl: "Resolutie" },
  panel: { en: "Panel", nl: "Paneel" },
  usb_c_power_delivery_w: {
    en: "USB-C power delivery",
    nl: "USB-C Power Delivery",
  },
};

const ATTRIBUTE_UNITS: Record<string, string> = {
  screen_size_inch: "″",
  power_w: " W",
  usb_c_power_delivery_w: " W",
};

function attributeLabel(key: string, lang: Lang): string {
  return (
    ATTRIBUTE_LABELS[key]?.[lang] ??
    key.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase())
  );
}

function claimStatus(
  status: VariantOfferDetail["claims"][number]["mappingStatus"],
  t: ReturnType<typeof dictionary>,
): string {
  if (status === "accepted") return t.claimStatusAccepted;
  if (status === "rejected") return t.claimStatusRejected;
  return t.claimStatusUnresolved;
}

function dictionary(lang: Lang) {
  return dictionaries[lang];
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const rawLang = (await searchParams).lang;
  const lang = resolveLang(Array.isArray(rawLang) ? rawLang[0] : rawLang);
  const t = dictionaries[lang];
  const otherLang: Lang = lang === "en" ? "nl" : "en";

  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const result = await getCore().catalogue.getVariantOfferDetail(
    identity.trusted.principal,
    id,
  );
  if (!result.ok && result.error.kind === "not-found") notFound();

  const shellIdentity = {
    name: identity.trusted.user.name,
    email: identity.trusted.user.email,
    role: identity.trusted.user.workspace.role,
    isAdministrator: identity.trusted.principal.kind === "administrator",
  };

  if (!result.ok) {
    return (
      <StudioShell lang={lang} identity={shellIdentity} active="products">
        <div className="error-panel" role="alert">
          <strong>{t.loadErrorTitle}</strong>
          <p>
            <a href={`/?lang=${lang}`}>{t.backToProducts}</a>
          </p>
        </div>
      </StudioShell>
    );
  }

  const detail = result.value;
  const provenanceByKey = new Map(
    detail.uncertainty.unverifiedAttributes.map((entry) => [entry.key, entry]),
  );
  const attributeClaims = detail.claims.filter((claim) => claim.field.startsWith("attribute."));

  return (
    <StudioShell lang={lang} identity={shellIdentity} active="products">
      <div className="topbar">
        <h1>{detail.variant.product.name}</h1>
        <a className="lang-switch" href={`/products/${id}?lang=${otherLang}`}>
          {t.languageSwitch}
        </a>
      </div>

      <p>
        <a href={`/?lang=${lang}`}>← {t.backToProducts}</a>
      </p>

      {detail.variant.product.isDevelopmentFixture && (
        <span className="badge-fixture">{t.fixtureBadge}</span>
      )}

      <section className="panel">
        <h2>{detail.variant.name}</h2>
        <p className="muted">
          {detail.variant.product.manufacturer ?? ""}
          {detail.variant.product.category ? ` · ${detail.variant.product.category}` : ""}
        </p>
        <p className="notice notice-warning">
          {detail.uncertainty.overall === "verified"
            ? t.detailUncertaintyVerified
            : t.detailUncertaintyPartial}
        </p>

        <h3 style={{ marginBottom: 0 }}>{t.attributes}</h3>
        <div className="attr-grid">
          {Object.entries(detail.variant.attributes).map(([key, value]) => {
            const provenance = provenanceByKey.get(key);
            return (
              <div className="attr" key={key}>
                <div className="k">{attributeLabel(key, lang)}</div>
                <div className="v">
                  {String(value)}
                  {ATTRIBUTE_UNITS[key] ?? ""}
                </div>
                <div className="attr-source">
                  {provenance?.status === "verified" ? (
                    <>
                      {t.attributeVerified}
                      {provenance.observedAt
                        ? ` · ${t.observedAt} ${formatObservedAt(provenance.observedAt, lang)}`
                        : ""}
                    </>
                  ) : (
                    t.attributeUnverified
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <h3>{t.sourcesLabel}</h3>
        {attributeClaims.length === 0 ? (
          <p className="muted">{t.noSourcesLabel}</p>
        ) : (
          <ul className="claim-list">
            {attributeClaims.map((claim) => (
              <li key={`${claim.field}-${claim.sourceUrl}-${claim.observedAt}`}>
                <strong>{claim.field.replace("attribute.", "")}</strong>: {String(claim.value)}{" "}
                · <span className="claim-status">{claimStatus(claim.mappingStatus, t)}</span>
                <div className="price-sub">
                  {t.claimSourceLabel}:{" "}
                  <a href={claim.sourceUrl} target="_blank" rel="noreferrer">
                    {claim.sourceUrl}
                  </a>
                </div>
                <div className="price-sub">
                  {t.claimObservedAtLabel}: {formatObservedAt(claim.observedAt, lang)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h3 style={{ marginTop: 0 }}>{t.offers}</h3>
        {detail.offers.length === 0 ? (
          <p className="muted">{t.noOffers}</p>
        ) : (
          detail.offers.map((offer) => (
            <div className="offer-card" key={offer.id}>
              <div>
                <strong>{offer.retailer.name}</strong>
                <div className="price-sub">
                  {t.condition}:{" "}
                  {offer.condition === "new" ? t.conditionNew : t.conditionRefurbished}
                </div>
                {offer.currentPrice && (
                  <div className="price-sub">
                    {t.observedAt}:{" "}
                    {formatObservedAt(offer.currentPrice.observedAt, lang)}
                  </div>
                )}
              </div>
              {offer.currentPrice && (
                <div style={{ textAlign: "right" }}>
                  <div className="price-main">
                    {formatMoney(
                      offer.currentPrice.deliveredAmount,
                      offer.currentPrice.currency,
                      lang,
                    )}
                  </div>
                  <div className="price-sub">
                    {t.deliveredTotal} · {t.includesVat} · {t.shipping}{" "}
                    {Number(offer.currentPrice.shippingAmount) === 0
                      ? t.freeShipping.toLowerCase()
                      : formatMoney(
                          offer.currentPrice.shippingAmount,
                          offer.currentPrice.currency,
                          lang,
                        )}
                  </div>
                </div>
              )}
              <a className="btn-primary" href={offer.url} target="_blank" rel="noreferrer">
                {t.viewOffer}
              </a>
            </div>
          ))
        )}
      </section>
    </StudioShell>
  );
}
