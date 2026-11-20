// SPDX-License-Identifier: AGPL-3.0-or-later
import { redirect } from "next/navigation";
import type {
  AttributeFilter,
  CatalogueSearchResponse,
  CatalogueSearchResult,
} from "@shopping/core";
import { getCore } from "@/lib/core";
import { requestIdentity } from "@/lib/auth/session";
import { dictionaries, resolveLang, type Lang } from "@/lib/i18n";
import { formatMoney, formatObservedAt } from "@/lib/format";
import { StudioShell } from "@/app/studio-shell";

const COLOURS = ["black", "white", "grey", "blue", "red", "silver"] as const;

const COLOUR_LABELS: Record<(typeof COLOURS)[number], Record<Lang, string>> = {
  black: { en: "Black", nl: "Zwart" },
  white: { en: "White", nl: "Wit" },
  grey: { en: "Grey", nl: "Grijs" },
  blue: { en: "Blue", nl: "Blauw" },
  red: { en: "Red", nl: "Rood" },
  silver: { en: "Silver", nl: "Zilver" },
};

function single(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * The page accepts the same three inputs the API does — words, an identifier,
 * and structured filters — and turns them into one core search. Every filter is
 * expressed through the canonical attribute vocabulary, so the form cannot ask
 * for something the catalogue does not model.
 */
function readFilters(params: Record<string, string | string[] | undefined>): AttributeFilter[] {
  const filters: AttributeFilter[] = [];
  const colour = single(params.colour).trim();
  if (colour) filters.push({ key: "colour", op: "eq", value: colour });
  const power = single(params.minPower).trim();
  if (power) filters.push({ key: "power_w", op: "gte", value: power });
  const screen = single(params.minScreen).trim();
  if (screen) filters.push({ key: "screen_size_inch", op: "gte", value: screen });
  return filters;
}

function matchLabel(match: CatalogueSearchResult["match"], t: ReturnType<typeof dictionary>): string {
  if (match.mode === "identifier") {
    return match.kind === "gtin" ? t.searchMatchGtin : t.searchMatchIdentifier;
  }
  if (match.mode === "attribute") return t.searchMatchAttribute;
  if (match.mode === "typo") return t.searchMatchTypo;
  return t.searchMatchText;
}

function dictionary(lang: Lang) {
  return dictionaries[lang];
}

function attributeLabel(key: string): string {
  return key.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

function ResultCard({
  result,
  lang,
  t,
}: {
  result: CatalogueSearchResult;
  lang: Lang;
  t: ReturnType<typeof dictionary>;
}) {
  const best = result.offers.best;
  const attributes = Object.entries(result.variant.attributes).slice(0, 6);
  return (
    <article className="panel result-card">
      <div className="result-head">
        <div>
          <h2>
            <a href={`/products/${result.variant.id}?lang=${lang}`}>
              {result.variant.product.name}
            </a>
          </h2>
          <p className="muted">{result.variant.name}</p>
        </div>
        <div className="result-price">
          {best ? (
            <>
              <div className="price-main">
                {formatMoney(best.deliveredAmount, best.currency, lang)}
              </div>
              <div className="price-sub">
                {t.deliveredTotal} · {t.observedAt}{" "}
                {formatObservedAt(best.observedAt, lang)}
              </div>
            </>
          ) : (
            <div className="price-sub">{t.noOffers}</div>
          )}
        </div>
      </div>

      <div className="result-badges">
        <span className={`badge-match badge-${result.match.mode}`}>
          {matchLabel(result.match, t)}
        </span>
        <span
          className={
            result.uncertainty === "verified"
              ? "badge-verified"
              : "badge-partial"
          }
        >
          {result.uncertainty === "verified"
            ? t.uncertaintyVerified
            : t.uncertaintyPartial}
        </span>
        {result.variant.product.isDevelopmentFixture && (
          <span className="badge-fixture">{t.fixtureBadge}</span>
        )}
      </div>

      {result.identifiers.manufacturerPartNumber && (
        <p className="muted identifier-line">
          {result.identifiers.manufacturerPartNumber}
          {result.identifiers.gtin ? ` · GTIN ${result.identifiers.gtin}` : ""}
        </p>
      )}

      {attributes.length > 0 && (
        <div className="attr-grid">
          {attributes.map(([key, value]) => {
            const provenance = result.attributeProvenance[key];
            return (
              <div className="attr" key={key}>
                <div className="k">{attributeLabel(key)}</div>
                <div className="v">{String(value)}</div>
                <div className="attr-source">
                  {provenance?.status === "verified"
                    ? `${t.attributeVerified}${provenance.observedAt ? ` · ${formatObservedAt(provenance.observedAt, lang)}` : ""}`
                    : t.attributeUnverified}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {result.unmatchedTerms.length > 0 && (
        <p className="notice notice-warning">
          {t.unmatchedTermsLabel}: {result.unmatchedTerms.join(", ")}
        </p>
      )}

      <details className="sources">
        <summary>{t.sourcesLabel}</summary>
        {result.sources.length === 0 ? (
          <p className="muted">{t.noSourcesLabel}</p>
        ) : (
          <ul>
            {result.sources.map((source) => (
              <li key={`${source.sourceUrl}-${source.observedAt}`}>
                <a href={source.sourceUrl} target="_blank" rel="noreferrer">
                  {source.sourceUrl}
                </a>
                <span className="price-sub">
                  {" "}
                  · {t.observedAt} {formatObservedAt(source.observedAt, lang)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const lang = resolveLang(params.lang);
  const t = dictionaries[lang];
  const otherLang: Lang = lang === "en" ? "nl" : "en";

  const identity = await requestIdentity();
  if (!identity) redirect(`/sign-in?lang=${lang}`);

  const text = single(params.text).trim();
  const identifiers = single(params.identifiers).trim();
  const filters = readFilters(params);
  const submitted = text !== "" || identifiers !== "" || filters.length > 0;

  let response: CatalogueSearchResponse | null = null;
  let failure: "invalid" | "error" | null = null;
  if (submitted) {
    const result = await getCore().catalogue.search(
      identity.trusted.principal,
      {
        ...(text ? { text } : {}),
        ...(identifiers ? { identifiers } : {}),
        ...(filters.length > 0 ? { filters } : {}),
      },
    );
    if (result.ok) response = result.value;
    else failure = result.error.kind === "invalid-input" ? "invalid" : "error";
  }

  const results = response?.results ?? [];
  const shellIdentity = {
    name: identity.trusted.user.name,
    email: identity.trusted.user.email,
    role: identity.trusted.user.workspace.role,
    isAdministrator: identity.trusted.principal.kind === "administrator",
  };

  return (
    <StudioShell lang={lang} identity={shellIdentity} active="products">
      <div className="topbar">
        <h1>{t.searchTitle}</h1>
        <a className="lang-switch" href={`/?lang=${otherLang}`}>
          {t.languageSwitch}
        </a>
      </div>

      <section className="panel">
        <p className="muted search-intro">{t.searchIntro}</p>
        <form className="search-form" method="get" action="/">
          <input type="hidden" name="lang" value={lang} />
          <div className="search-field search-field-wide">
            <label htmlFor="search-text">{t.searchTextLabel}</label>
            <input
              id="search-text"
              name="text"
              type="search"
              defaultValue={text}
              maxLength={200}
              placeholder={t.searchTextHint}
              autoComplete="off"
            />
          </div>
          <div className="search-field">
            <label htmlFor="search-identifiers">{t.searchIdentifierLabel}</label>
            <input
              id="search-identifiers"
              name="identifiers"
              type="text"
              defaultValue={identifiers}
              maxLength={64}
              placeholder="U2723QE"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="search-field">
            <label htmlFor="search-colour">{t.searchColourLabel}</label>
            <select id="search-colour" name="colour" defaultValue={single(params.colour)}>
              <option value="">{t.searchColourAny}</option>
              {COLOURS.map((colour) => (
                <option value={colour} key={colour}>
                  {COLOUR_LABELS[colour][lang]}
                </option>
              ))}
            </select>
          </div>
          <div className="search-field">
            <label htmlFor="search-power">{t.searchPowerLabel}</label>
            <input
              id="search-power"
              name="minPower"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              defaultValue={single(params.minPower)}
            />
          </div>
          <div className="search-field">
            <label htmlFor="search-screen">{t.searchScreenLabel}</label>
            <input
              id="search-screen"
              name="minScreen"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.1}
              defaultValue={single(params.minScreen)}
            />
          </div>
          <div className="search-actions">
            <button className="btn-primary" type="submit">
              {t.searchSubmit}
            </button>
            <a className="btn-quiet" href={`/?lang=${lang}`}>
              {t.searchClear}
            </a>
          </div>
        </form>
      </section>

      {failure === "invalid" && (
        <div className="error-panel" role="alert">
          <strong>{t.searchInvalidTitle}</strong>
          <p>{t.searchErrorBody}</p>
        </div>
      )}
      {failure === "error" && (
        <div className="error-panel" role="alert">
          <strong>{t.searchErrorTitle}</strong>
          <p>{t.searchErrorBody}</p>
        </div>
      )}

      {response && (
        <>
          {response.expansion.length > 0 && (
            <p className="muted expansion-line">
              {t.searchExpandedLabel}:{" "}
              {response.expansion
                .map((expansion) => expansion.terms.join(" / "))
                .join(" · ")}
            </p>
          )}
          <p className="muted results-count" aria-live="polite">
            {results.length === 1
              ? t.searchResultsOne
              : `${results.length} ${t.searchResultsCount}`}
          </p>
          {results.length === 0 ? (
            <section className="panel empty-panel">
              <h2>{t.searchNoResultsTitle}</h2>
              <p className="muted">{t.searchNoResultsBody}</p>
            </section>
          ) : (
            results.map((result) => (
              <ResultCard key={result.variant.id} result={result} lang={lang} t={t} />
            ))
          )}
        </>
      )}

      {!submitted && (
        <section className="panel empty-panel">
          <h2>{t.searchStartTitle}</h2>
          <p className="muted">{t.searchStartBody}</p>
        </section>
      )}
    </StudioShell>
  );
}
