// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Lang } from "./i18n";

const LOCALES: Record<Lang, string> = { en: "en-GB", nl: "nl-NL" };

export function formatMoney(
  amount: string,
  currency: string,
  lang: Lang,
): string {
  return new Intl.NumberFormat(LOCALES[lang], {
    style: "currency",
    currency,
  }).format(Number(amount));
}

export function formatObservedAt(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALES[lang], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
