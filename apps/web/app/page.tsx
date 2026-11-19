// SPDX-License-Identifier: AGPL-3.0-or-later
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DEVELOPMENT_FIXTURE_IDS } from "@shopping/db";
import type { VariantOfferDetail } from "@shopping/core";
import { dictionaries, resolveLang, type Lang } from "@/lib/i18n";
import { formatMoney, formatObservedAt } from "@/lib/format";
import { requestIdentity } from "@/lib/auth/session";
import { signOutAction } from "@/app/actions";
import { SignOutButton } from "@/app/auth-forms";

// Attribute keys rendered with English/Dutch labels; unknown attributes fall
// back to a readable version of the raw key.
const ATTRIBUTE_LABELS: Record<string, Record<Lang, string>> = {
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
  usb_c_power_delivery_w: " W",
};

function attributeLabel(key: string, lang: Lang): string {
  return (
    ATTRIBUTE_LABELS[key]?.[lang] ??
    key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase())
  );
}

async function loadDetail(
  host: string,
  proto: string,
): Promise<VariantOfferDetail | null> {
  const res = await fetch(
    `${proto}://${host}/api/catalogue/variants/${DEVELOPMENT_FIXTURE_IDS.variantId}`,
    { cache: "no-store" },
  );
  if (!res.ok) return null;
  return (await res.json()) as VariantOfferDetail;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];
  const otherLang: Lang = lang === "en" ? "nl" : "en";

  // Persisted conversations and watches require an account; anonymous
  // visitors sign in before reaching the Studio shell.
  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const requestHeaders = await headers();
  const host = requestHeaders.get("host") ?? "localhost:3000";
  const proto = requestHeaders.get("x-forwarded-proto") ?? "http";
  const detail = await loadDetail(host, proto);

  const isAdministrator = identity.trusted.principal.kind === "administrator";
  const roleLabel =
    identity.trusted.user.workspace.role === "owner" ? t.roleOwner : t.roleMember;

  return (
    <div className="app-shell" lang={lang}>
      <nav className="rail" aria-label="Main">
        <span className="brand">{t.appName}</span>
        <a className="nav-item" href={`/chat?lang=${lang}`}>
          {t.navChat}
        </a>
        <span className="nav-item active">{t.navProducts}</span>
        <span className="nav-item">
          {t.navCompare}
          <span className="nav-badge">{t.navComingSoon}</span>
        </span>
        <span className="nav-item">
          {t.navWatches}
          <span className="nav-badge">{t.navComingSoon}</span>
        </span>
        <a className="nav-item" href={`/settings?lang=${lang}`}>
          {t.navSettings}
        </a>
        <div className="rail-footer">
          <div className="rail-user">
            <strong>{identity.trusted.user.name}</strong>
            {identity.trusted.user.email}
            <br />
            {t.workspaceLabel} · {roleLabel}
            {isAdministrator ? ` · ${t.administratorRole}` : ""}
          </div>
          <a className="btn-quiet" href={`/account?lang=${lang}`}>
            {t.accountTitle}
          </a>
          {isAdministrator && (
            <a className="btn-quiet" href={`/administration/email?lang=${lang}`}>
              {t.navEmail}
            </a>
          )}
          <SignOutButton lang={lang} action={signOutAction} />
        </div>
      </nav>

      <main className="content">
        <div className="topbar">
          <h1>{t.navProducts}</h1>
          <a className="lang-switch" href={`/?lang=${otherLang}`}>
            {t.languageSwitch}
          </a>
        </div>

        {!detail ? (
          <div className="error-panel" role="alert">
            {t.loadErrorTitle}
          </div>
        ) : (
          <>
            {detail.variant.product.isDevelopmentFixture && (
              <span className="badge-fixture">{t.fixtureBadge}</span>
            )}
            <section className="panel">
              <h2>{detail.variant.product.name}</h2>
              <p className="muted">
                {detail.variant.name}
                {detail.variant.product.manufacturer
                  ? ` · ${detail.variant.product.manufacturer}`
                  : ""}
              </p>
              <p className="muted" style={{ fontSize: "13px" }}>
                {t.fixtureHint}
              </p>
              <h3 style={{ marginBottom: 0 }}>{t.attributes}</h3>
              <div className="attr-grid">
                {Object.entries(detail.variant.attributes).map(
                  ([key, value]) => (
                    <div className="attr" key={key}>
                      <div className="k">{attributeLabel(key, lang)}</div>
                      <div className="v">
                        {String(value)}
                        {ATTRIBUTE_UNITS[key] ?? ""}
                      </div>
                    </div>
                  ),
                )}
              </div>
            </section>

            <section className="panel">
              <h3>Source claims</h3>
              {detail.claims.filter((claim) => claim.field.startsWith("attribute.")).map((claim) => (
                <p className="muted" key={`${claim.field}-${claim.sourceUrl}`}>
                  {claim.field.replace("attribute.", "")}: {String(claim.value)} · {claim.mappingStatus === "unresolved" ? "Needs review" : "Validated"}
                </p>
              ))}
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
                        {offer.condition === "new"
                          ? t.conditionNew
                          : t.conditionRefurbished}
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
                    <a
                      className="btn-primary"
                      href={offer.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t.viewOffer}
                    </a>
                  </div>
                ))
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
