/**
 * Runs the model diagnostic against every configured provider for real.
 *
 * This is the optional live check: it contacts the providers in the operator's
 * environment and spends real money, so it is never part of `pnpm test`. It is
 * the same diagnostic the admin screen runs, so a green run here means what a
 * green diagnostic means.
 *
 * Usage:
 *
 *   MODEL_LIVE_CHECK=1 MODEL_OPENAI_API_KEY=... MODEL_BALANCED=openai:gpt-5-mini \
 *     node --experimental-strip-types scripts/live-check.ts
 *
 * Without MODEL_LIVE_CHECK=1 it reports that it was skipped and contacts
 * nothing, so running it by accident costs nothing.
 */
import { liveCheck } from "../src/live-check.ts";
import { loadModelConfiguration } from "../src/environment.ts";

const configuration = loadModelConfiguration();
const result = await liveCheck({ configuration });

if (result.skipped) {
  process.stdout.write(`${result.reason}\n`);
} else {
  for (const report of result.reports) {
    process.stdout.write(
      `${report.model.id} (${report.model.provider}/${report.model.model}): ` +
        `${report.status}, streaming ${report.capabilities.streaming}, ` +
        `tool calling ${report.capabilities.toolCalling}` +
        `${report.problem ? ` — ${report.problem}` : ""}\n`,
    );
  }
  const failed = result.reports.filter((report) => report.status !== "ready");
  process.exitCode = failed.length === 0 ? 0 : 1;
}
