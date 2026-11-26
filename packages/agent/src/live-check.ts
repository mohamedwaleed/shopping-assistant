import { diagnoseModel, type DiagnosticReport } from "./diagnostics.ts";
import type { ModelConfiguration } from "./providers.ts";

/**
 * The environment variable that turns the live check on. It is separate from
 * the model configuration on purpose: an installation reaches a provider in
 * normal use, while reaching it from the test suite is a deliberate act by
 * someone who has decided to spend real money against a real account.
 */
export const LIVE_CHECK_VARIABLE = "MODEL_LIVE_CHECK";

/** The live check runs only when it was asked for explicitly. */
export function liveCheckEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment[LIVE_CHECK_VARIABLE];
  return value === "1" || value === "true";
}

export interface LiveCheckResult {
  skipped: boolean;
  /** Why it was skipped, so a skipped run is never mistaken for a passing one. */
  reason?: string;
  reports: DiagnosticReport[];
}

/**
 * Exercises every configured model against the real provider.
 *
 * It is the same diagnostic the admin screen runs, with the same bounds, so a
 * green live check means what a green diagnostic means. It is skipped by default
 * because it needs real credentials and real money; the protocol fixtures cover
 * the same behaviour without either.
 */
export async function liveCheck({
  configuration,
  environment = process.env,
}: {
  configuration: ModelConfiguration;
  environment?: NodeJS.ProcessEnv;
}): Promise<LiveCheckResult> {
  if (!liveCheckEnabled(environment)) {
    return {
      skipped: true,
      reason: `${LIVE_CHECK_VARIABLE} is not set, so no provider was contacted`,
      reports: [],
    };
  }
  const reports: DiagnosticReport[] = [];
  for (const model of configuration.models) {
    reports.push(await diagnoseModel({ configuration, modelId: model.id }));
  }
  return { skipped: false, reports };
}
