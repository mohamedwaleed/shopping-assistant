import { randomUUID } from "node:crypto";
import type { Engine } from "@shopping-assistant/engine";
import {
  DEFAULT_DIAGNOSTIC_BOUNDS,
  diagnoseModel,
  UnknownModelError,
  type DiagnosticBounds,
  type DiagnosticReport,
} from "./diagnostics.ts";
import type { ModelConfiguration } from "./providers.ts";

/**
 * How often a model may be diagnosed. A diagnostic costs money like any other
 * call, so it is bounded on its own rather than by how often an operator
 * happens to open the screen: two runs per model per window, and a window is
 * deliberately long enough that a failure loop cannot be used as a spend loop.
 */
export interface DiagnosticAllowance {
  maxRuns: number;
  windowMs: number;
}

export const DEFAULT_DIAGNOSTIC_ALLOWANCE: DiagnosticAllowance = {
  maxRuns: 2,
  windowMs: 60_000,
};

/** What a diagnostic spends when it is not charged to a research run. */
export interface DiagnosticCost {
  /** Cents held for one diagnostic, and refunded if it could not be made. */
  cents: number;
  /** What one diagnostic is estimated to take. */
  estimatedDurationMs: number;
}

export const DEFAULT_DIAGNOSTIC_COST: DiagnosticCost = { cents: 2, estimatedDurationMs: 30_000 };

/**
 * A model as an administrator sees it. Readiness is reported, never assumed:
 * a model with no credential is `unconfigured`, and one whose provider has not
 * been diagnosed is `unverified` rather than `ready`.
 */
export interface ModelSelectionOption {
  id: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  route: string;
  readiness: "ready" | "unverified" | "unconfigured" | "incompatible" | "failed";
  /** When the verdict was reached, so a stale one can be told from a fresh one. */
  diagnosedAt?: string;
}

/** The model a conversation would use right now, and whether it is proven. */
export interface ActiveModel {
  id: string;
  provider: string;
  model: string;
  route: string;
  /** True when the admin chose it, false when the operator's own choice stands. */
  chosenByAdmin: boolean;
  readiness: "ready" | "unverified" | "unconfigured" | "incompatible" | "failed";
}

export type DiagnosticOutcome = DiagnosticReport | { status: "refused"; problem: string };

export interface ModelProviders {
  /** What an admin may choose from, with each option's readiness. */
  options(): Promise<ModelSelectionOption[]>;
  /** The model a conversation would use now. */
  active(): Promise<ActiveModel | undefined>;
  /**
   * Admins only. Exercises one model and reports what it does. A provider
   * failure is reported, never papered over by trying another provider.
   */
  diagnose(actor: { id: string }, modelId: string): Promise<DiagnosticOutcome>;
}

/** Raised when an administrator asks for a model the operator has not configured. */
export class ModelNotConfiguredError extends Error {
  constructor(modelId: string) {
    super(`The deployment has no provider for the model ${modelId}`);
    this.name = "ModelNotConfiguredError";
  }
}

/** Raised when a diagnostic allowance is used up, so the refusal is explicit. */
export class DiagnosticAllowanceExhaustedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super("The diagnostic allowance for this model is exhausted");
    this.name = "DiagnosticAllowanceExhaustedError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The engine's research ledger needs a run to charge to, and an operator's
 * diagnostic belongs to no conversation. Rather than invent a run that a
 * shopper's limits would then be shared with, the installation keeps one
 * dedicated run per model under the operator's own account, and diagnostics are
 * charged to it exactly like a conversation's calls. That is what keeps a
 * diagnostic inside the bounded allowance the research ledger already enforces.
 */
const DIAGNOSTIC_CONVERSATION_TITLE = "Model diagnostics";

export function createModelProviders({
  engine,
  configuration,
  bounds = DEFAULT_DIAGNOSTIC_BOUNDS,
  allowance = DEFAULT_DIAGNOSTIC_ALLOWANCE,
  cost = DEFAULT_DIAGNOSTIC_COST,
  fetch,
  now = () => new Date(),
}: {
  engine: Engine;
  configuration: ModelConfiguration;
  bounds?: DiagnosticBounds;
  allowance?: DiagnosticAllowance;
  cost?: DiagnosticCost;
  /** A transport, so a test answers from recorded bodies instead of a network. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}): ModelProviders {
  /** When each model was last diagnosed, which is what the allowance counts. */
  const diagnoses = new Map<string, Date[]>();
  /** The last verdict per model, kept in memory: a diagnostic is not policy. */
  const verdicts = new Map<string, { report: DiagnosticReport; at: Date }>();
  /**
   * One run per model, created on first use. The conversation is named after
   * the model, so an operator reading usage can tell diagnostics apart from
   * shopper traffic without reading any conversation content.
   */
  const runs = new Map<string, string>();

  function readinessOf(modelId: string): ModelSelectionOption["readiness"] {
    const model = configuration.models.find((candidate) => candidate.id === modelId);
    const provider = model
      ? configuration.providers.find((candidate) => candidate.id === model.provider)
      : undefined;
    if (!provider?.apiKey) return "unconfigured";
    const verdict = verdicts.get(modelId);
    if (!verdict) return "unverified";
    if (verdict.report.status === "ready") return "ready";
    if (verdict.report.status === "incompatible") return "incompatible";
    if (verdict.report.status === "unconfigured") return "unconfigured";
    return "failed";
  }

  /**
   * The model in force: the admin's choice where it is also configured, and
   * the first configured model otherwise. A policy naming a model this
   * deployment cannot reach is not silently replaced — `active` reports it as
   * unconfigured, because switching provider without being told is exactly the
   * fallback this ticket prohibits.
   */
  async function activeModel(): Promise<ActiveModel | undefined> {
    const policy = await engine.accounts.policy();
    const chosen = policy.modelId;
    const model = chosen
      ? configuration.models.find((candidate) => candidate.id === chosen)
      : configuration.models[0];
    if (!model) return undefined;
    return {
      id: model.id,
      provider: model.provider,
      model: model.model,
      route:
        configuration.providers.find((candidate) => candidate.id === model.provider)?.route ??
        "unknown",
      chosenByAdmin: chosen !== undefined,
      readiness: readinessOf(model.id),
    };
  }

  /** The run a model's diagnostics are charged to, created on first use. */
  async function diagnosticRun(actor: { id: string }, modelId: string): Promise<string> {
    const existing = runs.get(modelId);
    if (existing) {
      const run = await engine.research.get(actor.id, existing).catch(() => undefined);
      if (run) return run.id;
      runs.delete(modelId);
    }
    const conversation = await engine.conversations.create(actor.id, {
      title: `${DIAGNOSTIC_CONVERSATION_TITLE}: ${modelId}`,
    });
    const run = await engine.research.start(actor.id, conversation.id);
    runs.set(modelId, run.id);
    return run.id;
  }

  /** When the oldest counted diagnosis falls out of the window. */
  function exhaustedFor(modelId: string): number | undefined {
    const times = (diagnoses.get(modelId) ?? []).filter(
      (time) => now().getTime() - time.getTime() < allowance.windowMs,
    );
    diagnoses.set(modelId, times);
    if (times.length < allowance.maxRuns) return undefined;
    const oldest = times[0];
    return oldest ? allowance.windowMs - (now().getTime() - oldest.getTime()) : allowance.windowMs;
  }

  return {
    async options() {
      const offered = engine.administration.modelOptions();
      return offered
        .filter((option) => configuration.models.some((model) => model.id === option.id))
        .map((option) => {
          const model = configuration.models.find((candidate) => candidate.id === option.id);
          const provider = configuration.providers.find(
            (candidate) => candidate.id === model?.provider,
          );
          const verdict = verdicts.get(option.id);
          return {
            id: option.id,
            label: option.label,
            description: option.description,
            provider: model?.provider ?? "",
            model: model?.model ?? "",
            route: provider?.route ?? "unknown",
            readiness: readinessOf(option.id),
            ...(verdict ? { diagnosedAt: verdict.at.toISOString() } : {}),
          };
        });
    },

    active: activeModel,

    async diagnose(actor, modelId) {
      // A diagnostic spends the installation's money and reports how the
      // deployment is wired, so it is an administrator's operation. The engine
      // decides who is an admin; asking it for the catalog is how that is
      // settled, and it happens before any call is made or any run is opened.
      await engine.administration.modelCatalog(actor);
      const offered = engine.administration.modelOptions().map((option) => option.id);
      if (!offered.includes(modelId)) throw new ModelNotConfiguredError(modelId);
      if (!configuration.models.some((model) => model.id === modelId)) {
        throw new ModelNotConfiguredError(modelId);
      }

      const retryAfterMs = exhaustedFor(modelId);
      if (retryAfterMs !== undefined) throw new DiagnosticAllowanceExhaustedError(retryAfterMs);

      // A model with no credential is reported without being contacted, so
      // nothing is held for it: there is no call to pay for.
      const provider = configuration.providers.find(
        (candidate) => candidate.id === configuration.models.find((m) => m.id === modelId)?.provider,
      );
      if (!provider?.apiKey) {
        const report = await diagnoseModel({ configuration, modelId, bounds });
        verdicts.set(modelId, { report, at: now() });
        return report;
      }

      // Charged before it is made, to the same ledger a conversation uses, so a
      // diagnostic cannot escape the run, conversation, and daily ceilings.
      const runId = await diagnosticRun(actor, modelId);
      // The ledger stores references as uuids, and a reference is what makes a
      // retried call recognisable as the same one. A fresh one per diagnostic is
      // correct here: two diagnostics of one model are two calls, not a retry.
      const reference = randomUUID();
      const model = configuration.models.find((candidate) => candidate.id === modelId);
      const reservation = await engine.research.reserve(actor.id, runId, {
        reference,
        callKind: "model",
        pricing: pricingOf(cost, model?.pricePerMillionTokens, bounds),
        estimatedDurationMs: cost.estimatedDurationMs,
      });
      // Counted when the reservation is granted, so a provider that hangs or
      // fails still consumes the allowance: the money is spent either way.
      diagnoses.set(modelId, [...(diagnoses.get(modelId) ?? []), now()]);

      const started = Date.now();
      try {
        const report = await diagnoseModel({
          configuration,
          modelId,
          bounds,
          ...(fetch ? { fetch } : {}),
        });
        verdicts.set(modelId, { report, at: now() });
        await engine.research.settle(actor.id, {
          reservationId: reservation.id,
          ...(model?.pricePerMillionTokens
            ? { actualCents: actualCentsOf(model.pricePerMillionTokens, report) }
            : {}),
          durationMs: report.durationMs,
        });
        return report;
      } catch (error) {
        // A diagnostic that could not run at all gives its reservation back; a
        // provider failure that reached the wire settles, because it was paid
        // for. `diagnoseModel` reports those rather than throwing, so reaching
        // here means nothing was sent.
        await engine.research.release(actor.id, reservation.id);
        const problem =
          error instanceof UnknownModelError
            ? "no model is configured under that id"
            : "the diagnostic could not be run";
        const model = configuration.models.find((candidate) => candidate.id === modelId);
        return {
          status: "failed",
          model: {
            id: modelId,
            provider: model?.provider ?? "",
            model: model?.model ?? "",
            route: "unknown",
          },
          capabilities: { streaming: "not-exercised", toolCalling: "not-exercised" },
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: Date.now() - started,
          problem,
        };
      }
    },
  };
}

/**
 * What a diagnostic holds before it is made. The ledger refuses a settlement
 * above the reservation, so the reservation has to cover the most the call
 * could cost. With a token price that is the output cap at both rates, which is
 * deliberately conservative: a diagnostic cannot outgrow it, and whatever it
 * does not use is released when it settles.
 *
 * With no price known, the reservation is the fixed per-diagnostic cost and the
 * call settles at that estimate, marked as unpriced rather than as free.
 */
function pricingOf(
  cost: DiagnosticCost,
  price: { inputCents: number; outputCents: number } | undefined,
  bounds: DiagnosticBounds,
): { unitCents: number } {
  if (!price) return { unitCents: cost.cents };
  const perToken = (cents: number) => cents / 1_000_000;
  // Both calls may reach the output cap, and the input side is bounded by the
  // same cap as a generous upper bound on a short prompt.
  const worstCase =
    2 * bounds.maxOutputTokens * (perToken(price.inputCents) + perToken(price.outputCents));
  return { unitCents: Math.max(cost.cents, Math.ceil(worstCase)) };
}

/**
 * What a diagnostic actually cost at the operator's price. It is at most the
 * reservation, which is why the reservation covers the worst case above.
 */
function actualCentsOf(
  price: { inputCents: number; outputCents: number },
  report: DiagnosticReport,
): number {
  const perToken = (cents: number, tokens: number) => (cents * tokens) / 1_000_000;
  return Math.ceil(
    perToken(price.inputCents, report.usage.inputTokens) +
      perToken(price.outputCents, report.usage.outputTokens),
  );
}
