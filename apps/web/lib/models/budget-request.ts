// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BudgetAllowanceInput, BudgetPool, SaveBudgetAllowance } from "@shopping/core";
import { BUDGET_POOLS } from "@shopping/core";

/**
 * Translate a budget request body into a core request. Only known fields are
 * read; core owns authorization and clamping, so a workspace id here never
 * widens access.
 */
export function allowanceRequestFrom(body: Record<string, unknown>): SaveBudgetAllowance {
  return {
    ...(body.installation !== undefined
      ? { installation: allowanceFrom(body.installation) }
      : {}),
    ...(body.workspace !== undefined
      ? { workspace: body.workspace === null ? null : allowanceFrom(body.workspace) }
      : {}),
    ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
    ...(typeof body.workspaceOverrideAllowed === "boolean"
      ? { workspaceOverrideAllowed: body.workspaceOverrideAllowed }
      : {}),
    ...(typeof body.paidFallbackAllowed === "boolean"
      ? { paidFallbackAllowed: body.paidFallbackAllowed }
      : {}),
  };
}

function allowanceFrom(value: unknown): BudgetAllowanceInput {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    pool: poolFrom(record.pool),
    maxCalls: numberFrom(record.maxCalls),
    maxTokens: numberFrom(record.maxTokens),
    maxCents: numberFrom(record.maxCents),
  };
}

function poolFrom(value: unknown): BudgetPool {
  return BUDGET_POOLS.includes(value as BudgetPool) ? (value as BudgetPool) : "interactive";
}

/** Hand non-numbers through as NaN so core reports the field that is wrong. */
function numberFrom(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}
