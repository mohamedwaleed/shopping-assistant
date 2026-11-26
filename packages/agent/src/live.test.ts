import { describe, expect, it } from "vitest";
import { loadModelConfiguration } from "./environment.ts";
import { LIVE_CHECK_VARIABLE, liveCheck } from "./live-check.ts";

/**
 * The live check against real providers.
 *
 * It is skipped by default because it needs real credentials and spends real
 * money. Set `MODEL_LIVE_CHECK=1` together with the provider configuration to
 * run it: the same diagnostic the admin screen runs, against the providers the
 * environment actually names. Everything the default suite proves is proven
 * from protocol fixtures instead.
 */
describe.skipIf(process.env[LIVE_CHECK_VARIABLE] !== "1")("live provider check", () => {
  it("proves streaming and a typed tool call on every configured model", async () => {
    const configuration = loadModelConfiguration();
    expect(configuration.models.length).toBeGreaterThan(0);
    const result = await liveCheck({ configuration });
    expect(result.skipped).toBe(false);
    for (const report of result.reports) {
      // A provider that cannot do both would leave the conversation unable to
      // stream an answer or call a shopping tool, so both are required here.
      expect(report.status, `${report.model.id}: ${report.problem ?? ""}`).toBe("ready");
      expect(report.capabilities).toEqual({ streaming: "supported", toolCalling: "supported" });
    }
  });
});
