// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Result } from "../errors";
import type { Principal } from "../principal";
import type { ResolvedModel, UsageSource } from "./types";

/**
 * Two pools that never share an allowance: interactive research answers a
 * shopper now, background monitoring spends on schedules nobody is waiting
 * for. Exhausting one must leave the other untouched (spec, Spending).
 */
export const BUDGET_POOLS = ["interactive", "background"] as const;
export type BudgetPool = (typeof BUDGET_POOLS)[number];

/** The unit of provider work a budget is denominated in. */
export const BUDGET_UNITS = ["calls", "tokens", "cents"] as const;
export type BudgetUnit = (typeof BUDGET_UNITS)[number];

/**
 * Conservative per-call cost used where a provider publishes no exact
 * pre-call price: the full context is assumed to be input, the whole output
 * allowance is assumed to be produced, and retries are charged again.
 */
export interface CostEstimate {
  tokens: number;
  cents: number;
  basis: "estimated" | "reported";
}

export interface BudgetLimits {
  maxCalls: number;
  maxTokens: number;
  maxCents: number;
}

export interface BudgetAllowanceInput {
  pool: BudgetPool;
  maxCalls: number;
  maxTokens: number;
  maxCents: number;
}

export interface SaveBudgetAllowance {
  /** The workspace override, or null to remove it. Ignored for the installation. */
  workspace?: BudgetAllowanceInput | null;
  /** The installation ceiling for this pool. Administrators only. */
  installation?: BudgetAllowanceInput;
  /**
   * The workspace these permissions and overrides apply to. An administrator
   * granting permission names the workspace; anyone else may only act on their
   * own, so a supplied id never widens access.
   */
  workspaceId?: string;
  /** Whether workspaces may set their own allowance at all. */
  workspaceOverrideAllowed?: boolean;
  /** Whether workspaces may opt into a paid provider fallback. */
  paidFallbackAllowed?: boolean;
}

export interface BudgetUsage {
  calls: number;
  tokens: number;
  cents: number;
  /** Calls still reserved and not yet settled. */
  inFlightCalls: number;
}

/**
 * Why a spent allowance stopped provider work. Consent and fallback are
 * separate typed errors (`budget-consent-required`, `paid-fallback-not-enabled`)
 * because they stop a request before an allowance is even consulted.
 */
export type BudgetPauseReason = "calls-exhausted" | "tokens-exhausted" | "spend-exhausted";

export interface BudgetPause {
  pool: BudgetPool;
  reason: BudgetPauseReason;
  /** The unit that ran out, absent for the consent and fallback pauses. */
  unit?: BudgetUnit;
  limit?: number;
  used?: number;
}

export interface BudgetPoolView {
  pool: BudgetPool;
  /** The installation ceiling; the override is clamped to it, never added. */
  installation: BudgetLimits;
  /** What this workspace asked for, unclamped, or null when it did not. */
  workspace: BudgetLimits | null;
  /** What actually applies: min(override, ceiling) per unit. */
  effective: BudgetLimits;
  /** True when an override asked for more than the ceiling allowed. */
  clamped: boolean;
  usage: BudgetUsage;
  window: { startedAt: string; endsAt: string };
  paused: BudgetPause | null;
}

export interface BudgetUsageView {
  workspaceId: string;
  pools: BudgetPoolView[];
  consent: { backgroundPersonalKey: boolean };
  fallback: { paidAllowed: boolean; workspaceMayRequest: boolean };
  estimates: {
    basis: "conservative";
    assumption: string;
    defaults: BudgetLimits;
    ceilings: BudgetLimits;
  };
}

export interface BudgetReservation {
  id: string;
  workspaceId: string;
  pool: BudgetPool;
  usageSource: UsageSource;
  reserved: CostEstimate;
  actual: CostEstimate | null;
  status: "reserved" | "settled" | "released";
  attempt: number;
  expiresAt: string;
}

/**
 * What a caller does with a reservation. Settle reports what the provider said
 * it used; release says the call never reached the provider and costs nothing.
 */
export interface SettleReservation {
  reservationId: string;
  actual?: Partial<Pick<CostEstimate, "tokens" | "cents">>;
}

export interface BudgetRequest {
  pool: BudgetPool;
  /** The model the caller resolved through the registry; never re-resolved here. */
  model: ResolvedModel;
  /** Conservative estimate of what the call will consume. */
  estimate?: Partial<CostEstimate>;
  /** Retryable failures already spent on this unit of work. */
  attempt?: number;
  /** The reservation whose provider call is being retried. */
  retryOf?: string;
}

/**
 * A granted reservation carries the resolved model it was granted for, so a
 * caller cannot reserve against one model and call another.
 */
export interface BudgetGrant {
  reservation: BudgetReservation;
  model: ResolvedModel;
}

export interface Budgets {
  read(principal: Principal): Promise<Result<BudgetUsageView>>;
  saveAllowance(
    principal: Principal,
    input: SaveBudgetAllowance,
  ): Promise<Result<BudgetUsageView>>;
  setPersonalKeyBackgroundConsent(
    principal: Principal,
    allowed: boolean,
  ): Promise<Result<BudgetUsageView>>;
  /** Reserve before a provider call. A paused budget is a typed error. */
  reserve(
    principal: Principal,
    request: BudgetRequest,
  ): Promise<Result<BudgetGrant>>;
  settle(
    principal: Principal,
    input: SettleReservation,
  ): Promise<Result<BudgetReservation>>;
  release(
    principal: Principal,
    reservationId: string,
  ): Promise<Result<BudgetReservation>>;
}
