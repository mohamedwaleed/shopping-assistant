// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { dictionaries } from "@/lib/i18n";

/**
 * Last-resort error boundary for the catalogue pages. Expected failures (an
 * empty search, an unknown attribute) are rendered as part of the page; this
 * only catches something unexpected, such as the database being unreachable.
 */
export default function SearchError({ retry }: { error: unknown; retry: () => void }) {
  const t = dictionaries.en;
  return (
    <main className="content">
      <div className="error-panel" role="alert">
        <strong>{t.searchErrorTitle}</strong>
        <p>{t.searchErrorBody}</p>
        <button className="btn-primary" type="button" onClick={() => retry()}>
          {t.searchRetry}
        </button>
      </div>
    </main>
  );
}
