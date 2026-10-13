// @vitest-environment node
import { estimateCostUsd, MODEL_PROFILES } from "@sched/agent";
import { describe, expect, it } from "vitest";

import { formatRunCost, sumTraceCost } from "./cost";

const usage = { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 20_000, cacheWriteTokens: 1_000 };

describe("sumTraceCost", () => {
  it("sums every trace at its own profile's prices and counts the turns", () => {
    const cost = sumTraceCost([
      { modelProfile: "sonnet-4.6", usage },
      { modelProfile: "sonnet-4.6", usage },
      { modelProfile: "haiku-4.5", usage },
    ]);
    const sonnet = estimateCostUsd(MODEL_PROFILES["sonnet-4.6"], usage);
    const haiku = estimateCostUsd(MODEL_PROFILES["haiku-4.5"], usage);
    expect(sonnet).toBeGreaterThan(haiku);
    expect(cost.turns).toBe(3);
    expect(cost.usd).toBeCloseTo(2 * sonnet + haiku, 10);
  });

  it("is zero over no turns", () => {
    expect(sumTraceCost([])).toEqual({ usd: 0, turns: 0 });
  });

  it("throws on a profile it can't price", () => {
    expect(() => sumTraceCost([{ modelProfile: "gpt-9", usage }])).toThrow(
      'No prices for model profile "gpt-9"',
    );
  });
});

describe("formatRunCost", () => {
  it("prints the A-8 line", () => {
    expect(formatRunCost({ usd: 0.123456, turns: 12 })).toBe(
      "Estimated Bedrock cost (list prices): $0.1235 over 12 turns",
    );
  });
});
