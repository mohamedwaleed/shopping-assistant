/**
 * Reading prices and quantities the way pages write them.
 *
 * A price is money plus a currency plus, often, a claim about what it covers
 * (a unit, a range, a monthly instalment). Anything this module cannot read
 * with confidence becomes `undefined` rather than a guess: an unknown price is
 * a fact a shopper can act on, while a wrong one is not.
 */

export interface Money {
  /** In the currency's minor unit (cents for EUR), so nothing is rounded twice. */
  amountMinor: number;
  /** ISO 4217 code, upper case. */
  currency: string;
  /** The price exactly as the page wrote it, so a shopper can check it. */
  text: string;
}

/** Currencies whose minor unit is not one hundredth, or which use none. */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);

/** Symbols that name one currency unambiguously. */
const SYMBOL_CURRENCIES: Readonly<Record<string, string>> = {
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  "₽": "RUB",
  "₩": "KRW",
  "₺": "TRY",
  "₪": "ILS",
  "₫": "VND",
  "฿": "THB",
  "₴": "UAH",
  "₦": "NGN",
  "₱": "PHP",
  "R$": "BRL",
};

/** ISO codes that appear in text often enough to be worth recognising. */
const ISO_CURRENCY_CODES: ReadonlySet<string> = new Set([
  "AED", "ARS", "AUD", "BGN", "BRL", "CAD", "CHF", "CLP", "CNY", "COP", "CZK", "DKK", "EGP",
  "EUR", "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MAD", "MXN", "MYR",
  "NGN", "NOK", "NZD", "PHP", "PLN", "RON", "RSD", "RUB", "SAR", "SEK", "SGD", "THB", "TRY",
  "TWD", "UAH", "USD", "VND", "ZAR",
]);

function minorUnitsOf(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

/** A decimal string as an integer amount, without going through a float. */
function toMinorUnits(decimal: string, currency: string): number | undefined {
  const places = minorUnitsOf(currency);
  const [whole = "", fraction = ""] = decimal.split(".");
  const padded = `${fraction}${"0".repeat(places)}`.slice(0, places);
  if (whole.length === 0 && padded.length === 0) return undefined;
  const amount = Number(`${whole || "0"}${padded}`);
  return Number.isSafeInteger(amount) ? amount : undefined;
}

/**
 * Reads a price out of a text or a number.
 *
 * `hintCurrency` is used when the text names none, which is the common case in
 * structured data where the currency is a separate property. A text that names
 * two different currencies is refused rather than resolved, because a page that
 * does that is stating a conversion and not a price.
 */
export function parseMoney(
  source: string | number | undefined,
  hintCurrency?: string | undefined,
): Money | undefined {
  if (source === undefined) return undefined;
  if (typeof source === "number") {
    if (!Number.isFinite(source) || source < 0) return undefined;
    const currency = normaliseCurrency(hintCurrency);
    if (!currency) return undefined;
    const places = minorUnitsOf(currency);
    return {
      amountMinor: Math.round(source * 10 ** places),
      currency,
      text: source.toFixed(places),
    };
  }

  const text = source.trim();
  if (text.length === 0) return undefined;
  const upper = text.toUpperCase();
  // A code only counts when it stands alone as a word: `EUR` in "EUR 89.95",
  // but not the `EUR` inside "euro" or "EUROPE".
  const codes = [...ISO_CURRENCY_CODES].filter((code) =>
    new RegExp(`(^|[^A-Z])${code}($|[^A-Z])`).test(upper),
  );
  // A symbol that starts with a letter, such as `R$`, is only a currency when
  // it is not the tail of a longer word; `$` on its own counts wherever it
  // appears, because no word ends in one.
  const symbols = Object.keys(SYMBOL_CURRENCIES).filter((symbol) => {
    if (symbol === "$") return text.includes(symbol);
    const index = text.indexOf(symbol);
    return index !== -1 && !/[A-Za-z]/.test(text[index - 1] ?? "");
  });
  const named = new Set([
    ...codes,
    ...symbols.map((symbol) => SYMBOL_CURRENCIES[symbol] ?? "").filter((code) => code !== ""),
  ]);
  if (named.size > 1) return undefined;
  const currency = normaliseCurrency([...named][0] ?? hintCurrency);
  if (!currency) return undefined;

  // The first number, with any grouping and with at most one decimal
  // separator. A dot between exactly three digits is a thousands group, as it
  // is in every locale that writes prices; one or two digits are a fraction.
  const match = /(\d{1,3}(?:[\s.,'’]\d{3})+|\d+)([.,]\d{1,2})?/.exec(text);
  if (!match) return undefined;
  const whole = (match[1] ?? "").replace(/[^\d]/g, "");
  const fraction = (match[2] ?? "").replace(/[^\d]/g, "");
  if (whole.length === 0) return undefined;
  const amountMinor = toMinorUnits(fraction === "" ? whole : `${whole}.${fraction}`, currency);
  if (amountMinor === undefined) return undefined;
  return { amountMinor, currency, text };
}

/** A currency code in the form the money type uses, if it is a plausible one. */
export function normaliseCurrency(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const trimmed = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(trimmed) ? trimmed : undefined;
}

export interface PriceRange {
  low: Money;
  high: Money;
}

/** Reads "€19.99 – €24.99" and its many spellings into a range. */
export function parsePriceRange(
  source: string | undefined,
  hintCurrency?: string | undefined,
): PriceRange | undefined {
  if (source === undefined) return undefined;
  const parts = source.split(/\s*(?:–|—|-|to|bis|à|tot)\s*/i).filter((part) => part.trim() !== "");
  if (parts.length < 2) return undefined;
  const low = parseMoney(parts[0], hintCurrency);
  const high = parseMoney(parts[1], hintCurrency ?? low?.currency);
  return low && high ? { low, high } : undefined;
}

/** Whether a price is stated as being for a unit of measure, as groceries are. */
export function unitBasisOf(text: string): string | undefined {
  // A unit is only a unit when it is not the tail of a word: "per litre" but
  // not the "l" in "per family". Longer names come first, so "ml" is never read
  // as the "m" of "ml".
  const match =
    /(?:\/|\bper)\s*(?:(\d+(?:[.,]\d+)?)\s*)?(kilograms?|kg|grams?|g|litres?|liters?|l|centilitres?|centiliters?|cl|millilitres?|milliliters?|ml|metres?|meters?|m|st(?:ü|ue)ck|pieces?|pcs|each|units?)(?![a-z])/i.exec(
      text,
    );
  if (!match) return undefined;
  const quantity = match[1]?.trim();
  const unit = (match[2] ?? "").toLowerCase();
  return quantity ? `${quantity} ${unit}` : unit;
}

/** Whether a price is an instalment rather than what the product costs. */
export function isInstalmentText(text: string): boolean {
  return /\b(?:per month|\/\s*month|monthly|a month|mtl\.?|instal?ment|financing|credit|leasing)\b/i.test(
    text,
  );
}
