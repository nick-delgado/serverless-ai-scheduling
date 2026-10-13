// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formatGreeting, GREETING_BUDGET_MS, summarizeGreeting } from "./stats";

/** 1..n milliseconds, shuffled, so the summary has to sort. */
const ramp = (n: number) => Array.from({ length: n }, (_, i) => ((i * 7) % n) + 1);

describe("summarizeGreeting", () => {
  it("takes nearest-rank percentiles: with 50 samples the p95 is the 48th smallest", () => {
    const s = summarizeGreeting(ramp(50), 2);
    expect(s).toEqual({ n: 50, p50: 25, p95: 48, max: 50, discarded: 2, withinBudget: true });
  });

  it("passes a p95 of exactly the budget and fails one just over it", () => {
    const at = [...Array<number>(47).fill(100), GREETING_BUDGET_MS, 9000, 9000];
    expect(summarizeGreeting(at, 0).withinBudget).toBe(true);
    const over = [...Array<number>(47).fill(100), GREETING_BUDGET_MS + 1, 9000, 9000];
    expect(summarizeGreeting(over, 0)).toMatchObject({ p95: GREETING_BUDGET_MS + 1, withinBudget: false });
  });

  it("never passes without samples", () => {
    expect(summarizeGreeting([], 50)).toEqual({
      n: 0,
      p50: 0,
      p95: 0,
      max: 0,
      discarded: 50,
      withinBudget: false,
    });
  });
});

describe("formatGreeting", () => {
  it("prints n, p50, p95, max, discarded and the verdict", () => {
    expect(formatGreeting(summarizeGreeting(ramp(50), 1))).toBe(
      "FR-010 greeting: n=50, p50 25 ms, p95 48 ms, max 50 ms, discarded 1; p95 within the 1500 ms budget",
    );
    expect(formatGreeting(summarizeGreeting([1600.4], 0))).toContain(
      "p95 1600 ms, max 1600 ms, discarded 0; p95 over",
    );
  });
});
