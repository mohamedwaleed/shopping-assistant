// SPDX-License-Identifier: AGPL-3.0-or-later
export type Lang = "en" | "nl";

export const dictionaries = {
  en: {
    appName: "Shopping Assistant",
    navChat: "Chat",
    navProducts: "Products",
    navCompare: "Compare",
    navWatches: "Watches",
    fixtureBadge: "Example product — development fixture",
    fixtureHint:
      "Loaded from PostgreSQL through the core and HTTP API. Fixtures are separate from live data.",
    attributes: "Specifications",
    offers: "Offers",
    deliveredTotal: "Delivered total",
    shipping: "Shipping",
    freeShipping: "Free",
    includesVat: "incl. VAT",
    observedAt: "Price observed",
    condition: "Condition",
    conditionNew: "New",
    conditionRefurbished: "Refurbished",
    viewOffer: "View offer",
    noOffers: "No offers are known for this variant yet.",
    loadErrorTitle: "Could not load this product",
    languageSwitch: "Nederlands",
    navComingSoon: "Planned",
  },
  nl: {
    appName: "Shopping Assistant",
    navChat: "Chat",
    navProducts: "Producten",
    navCompare: "Vergelijken",
    navWatches: "Volgen",
    fixtureBadge: "Voorbeeldproduct — ontwikkelingsfixture",
    fixtureHint:
      "Geladen vanuit PostgreSQL via de core en HTTP-API. Fixtures staan los van echte data.",
    attributes: "Specificaties",
    offers: "Aanbiedingen",
    deliveredTotal: "Totaal incl. bezorging",
    shipping: "Verzending",
    freeShipping: "Gratis",
    includesVat: "incl. btw",
    observedAt: "Prijs waargenomen",
    condition: "Conditie",
    conditionNew: "Nieuw",
    conditionRefurbished: "Refurbished",
    viewOffer: "Bekijk aanbieding",
    noOffers: "Voor deze variant zijn nog geen aanbiedingen bekend.",
    loadErrorTitle: "Dit product kon niet geladen worden",
    languageSwitch: "English",
    navComingSoon: "Gepland",
  },
} as const;

export type Dictionary = (typeof dictionaries)[Lang];

export function resolveLang(value: string | string[] | undefined): Lang {
  return value === "nl" ? "nl" : "en";
}
