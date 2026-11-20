// SPDX-License-Identifier: AGPL-3.0-or-later
import { type AttributeFilter, type FilterOperator, type Principal } from "@shopping/core";
import { getCore } from "@/lib/core";
import { errorResponse } from "@/lib/http";

// Public catalogue facts are readable without a workspace principal; private
// operations arrive with the workspace-access story.
const CATALOGUE_PRINCIPAL: Principal = { kind: "anonymous" };

const OPERATORS: ReadonlyArray<FilterOperator> = ["eq", "gte", "lte"];

/**
 * `filter=<key>:<value>` or `filter=<key>:<op>:<value>`. Values may contain
 * colons (a time, a URL fragment), so only the first two segments are syntax.
 */
function parseFilter(
  raw: string,
): { ok: true; filter: AttributeFilter } | { ok: false; message: string } {
  const [key, second, ...rest] = raw.split(":");
  if (!key || !second) {
    return { ok: false, message: "Use filter=<attribute>:<value> or filter=<attribute>:<op>:<value>" };
  }
  const operator = OPERATORS.find((candidate) => candidate === second);
  if (operator && rest.length > 0) {
    return { ok: true, filter: { key, op: operator, value: rest.join(":") } };
  }
  return { ok: true, filter: { key, op: "eq", value: [second, ...rest].join(":") } };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rawFilters = url.searchParams.getAll("filter");
  const filters: AttributeFilter[] = [];
  for (const raw of rawFilters) {
    const parsed = parseFilter(raw);
    if (!parsed.ok) {
      return errorResponse({ kind: "invalid-input", field: "filter", message: parsed.message });
    }
    filters.push(parsed.filter);
  }

  const limit = url.searchParams.get("limit");
  const result = await getCore().catalogue.search(CATALOGUE_PRINCIPAL, {
    ...(url.searchParams.get("identifiers")
      ? { identifiers: url.searchParams.get("identifiers")! }
      : {}),
    ...(url.searchParams.get("text") ? { text: url.searchParams.get("text")! } : {}),
    ...(filters.length > 0 ? { filters } : {}),
    ...(limit !== null && limit.trim() !== "" && Number.isFinite(Number(limit))
      ? { limit: Number(limit) }
      : {}),
  });

  if (!result.ok) {
    return errorResponse(result.error);
  }
  return Response.json(result.value);
}
