// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ModelTarget } from "@shopping/core";
import { createAiSdkProbe } from "@/lib/models/ai-sdk-probe";

/**
 * Separately configured live smoke checks. Nothing here runs by default and no
 * CI job sets these variables, so the deterministic fixture suite is the only
 * automatic proof; these confirm a real endpoint when an operator supplies one.
 *
 *   LIVE_OPENAI_API_KEY=sk-...            (optional LIVE_OPENAI_MODEL)
 *   LIVE_ANTHROPIC_API_KEY=sk-ant-...     (optional LIVE_ANTHROPIC_MODEL)
 *   LIVE_COMPATIBLE_API_KEY=... LIVE_COMPATIBLE_BASE_URL=http://host:port/v1
 *                                         (optional LIVE_COMPATIBLE_MODEL)
 *
 * Each check spends at most four calls of 32 output tokens (docs/adr/0012).
 */
const BOUNDS = { maxCalls: 4, maxOutputTokens: 32 } as const;

interface LiveTarget {
  label: string;
  target: ModelTarget;
  apiKey: string;
}

const candidates: Array<LiveTarget | null> = [
  process.env.LIVE_OPENAI_API_KEY
    ? {
        label: "openai",
        target: {
          provider: "openai",
          modelId: process.env.LIVE_OPENAI_MODEL ?? "gpt-5-mini",
        },
        apiKey: process.env.LIVE_OPENAI_API_KEY,
      }
    : null,
  process.env.LIVE_ANTHROPIC_API_KEY
    ? {
        label: "anthropic",
        target: {
          provider: "anthropic",
          modelId: process.env.LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
        },
        apiKey: process.env.LIVE_ANTHROPIC_API_KEY,
      }
    : null,
  process.env.LIVE_COMPATIBLE_API_KEY && process.env.LIVE_COMPATIBLE_BASE_URL
    ? {
        label: "compatible",
        target: {
          provider: "compatible",
          modelId: process.env.LIVE_COMPATIBLE_MODEL ?? "local-model",
          endpoint: process.env.LIVE_COMPATIBLE_BASE_URL,
        },
        apiKey: process.env.LIVE_COMPATIBLE_API_KEY,
      }
    : null,
];
const liveTargets: LiveTarget[] = candidates.filter((entry): entry is LiveTarget => entry !== null);

describe.skipIf(liveTargets.length === 0)("live provider smoke checks", () => {
  it.each(liveTargets)(
    "reaches a real $label endpoint within the diagnostic bounds",
    async ({ target, apiKey }) => {
      const result = await createAiSdkProbe()({
        target,
        provider: target.provider,
        apiKey,
        bounds: BOUNDS,
      });
      if (!result.ok) throw new Error(`probe refused: ${result.error.kind}`);
      const report = result.value;

      // A reachable endpoint must at least answer the text probe; the other
      // capabilities are reported as observed rather than assumed.
      expect(report.capabilities.text).toBe("supported");
      expect(report.bounds).toEqual(BOUNDS);
      expect(JSON.stringify(report)).not.toContain(apiKey);
    },
    60_000,
  );
});
