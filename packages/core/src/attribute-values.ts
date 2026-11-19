// SPDX-License-Identifier: AGPL-3.0-or-later
export interface CanonicalAttributeValue { key: string; valueType: string; unit: string | null; }

function read(input: unknown): { value: unknown; unit: string | null } {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const raw = input as Record<string, unknown>;
    return { value: raw.value, unit: typeof raw.unit === "string" ? raw.unit : null };
  }
  return { value: input, unit: null };
}

function unit(value: string): string { return value.trim().toLowerCase(); }

function convert(value: number, source: string | null, target: string | null): number | null {
  if (!target || !source || unit(source) === unit(target)) return value;
  if (unit(target) === "w") {
    if (["w", "watt", "watts"].includes(unit(source))) return value;
    if (["kw", "kilowatt", "kilowatts"].includes(unit(source))) return value * 1000;
  }
  if (["in", "inch", "inches"].includes(unit(target))) {
    if (["in", "inch", "inches"].includes(unit(source))) return value;
    if (["cm", "centimetre", "centimeter"].includes(unit(source))) return value / 2.54;
    if (["mm", "millimetre", "millimeter"].includes(unit(source))) return value / 25.4;
  }
  return null;
}

/** A value only becomes a canonical attribute after type and unit validation. */
export function canonicalizeAttributeValue(attribute: CanonicalAttributeValue, input: unknown): unknown | null {
  const source = read(input);
  if (attribute.valueType === "text") return typeof source.value === "string" && source.value.trim() ? source.value.trim() : null;
  if (attribute.valueType === "boolean") return typeof source.value === "boolean" ? source.value : source.value === "true" ? true : source.value === "false" ? false : null;
  if (attribute.valueType !== "number") return null;
  const number = typeof source.value === "number" ? source.value : Number(source.value);
  if (!Number.isFinite(number)) return null;
  const converted = convert(number, source.unit, attribute.unit);
  return converted === null ? null : Number(converted.toFixed(6));
}
