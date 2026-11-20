// SPDX-License-Identifier: AGPL-3.0-or-later
import { dictionaries } from "@/lib/i18n";

/**
 * Shown while a search streams in. It is deliberately static: the search runs
 * entirely in PostgreSQL, so there is no model or embedding step to wait for.
 */
export default function LoadingSearch() {
  const t = dictionaries.en;
  return (
    <main className="content" aria-busy="true">
      <p className="muted" role="status">
        {t.searchWorking}
      </p>
      <div className="skeleton-panel" />
      <div className="skeleton-panel" />
    </main>
  );
}
