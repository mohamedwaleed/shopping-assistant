// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries, resolveLang } from "@/lib/i18n";

/**
 * A variant that is not in this installation's catalogue. It sits at the app
 * root because `notFound()` renders the nearest `not-found.js` at or above the
 * segment that raised it.
 */
export default function ProductNotFound() {
  const lang = resolveLang(undefined);
  const t = dictionaries[lang];
  return (
    <main className="content" lang={lang}>
      <div className="panel empty-panel" role="status">
        <h1>{t.productNotFoundTitle}</h1>
        <p className="muted">{t.productNotFoundBody}</p>
        <a className="btn-primary" href={`/?lang=${lang}`}>
          {t.backToProducts}
        </a>
      </div>
    </main>
  );
}
