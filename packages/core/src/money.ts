// SPDX-License-Identifier: AGPL-3.0-or-later

/** Exact comparison of two money strings; never goes through a float. */
export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const left = toCents(a);
  const right = toCents(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Exact decimal addition for money strings (cents via BigInt, no floats). */
export function addMoney(a: string, b: string): string {
  const sum = toCents(a) + toCents(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function toCents(value: string): bigint {
  const negative = value.startsWith("-");
  const [integer = "0", fraction = ""] = value
    .replace("-", "")
    .split(".");
  const cents = BigInt((fraction + "00").slice(0, 2));
  return (negative ? -1n : 1n) * (BigInt(integer) * 100n + cents);
}
