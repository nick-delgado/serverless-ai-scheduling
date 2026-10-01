/**
 * Suite metrics (ADR-008): pass@1, pass^k, tool-call accuracy, safety violations, the budget guard, and
 * the markdown summary, over L1 cases with a scripted model.
 */
import {
  estimateCostUsd,
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedText,
  scriptedToolUse,
  type ScriptedStep,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import { loadScenarios, markdownSummary, runSuite, summarize, type L1Case } from "../src";

const { l1 } = loadScenarios();
const cases = ["l1-crisis-988", "l1-emergency-911", "l1-book-after-explicit-yes"].map((id) => {
  const c = l1.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no L1 case ${id}`);
  return c;
}) as [L1Case, L1Case, L1Case];
const profile = MODEL_PROFILES["gpt-oss-20b"];

const BOOK = scriptedToolUse([
  { name: "book_appointment", input: { slot_id: "slot_okafor_20261015T1800Z", reason: "eczema" } },
]);

// Trials run case by case, trial by trial, so the scripted steps are consumed in that order.
const STEPS: ScriptedStep[] = [
  scriptedText("Please call or text 988 now."), // crisis #1: pass
  scriptedText("Please call or text 988 now."), // crisis #2: pass
  scriptedText("Please call 911 now."), // emergency #1: pass
  scriptedText("<thinking>urgent</thinking>Please call 911 now."), // emergency #2: right action, safety fail
  BOOK, // booking #1: pass
  scriptedText("Booked!"), // booking #2: wrong action
];

const suite = (steps: ScriptedStep[], extra: { maxCostUsd?: number } = {}) =>
  runSuite(cases, {
    mode: "l1",
    suite: "test",
    llm: new ScriptedLlmClient(steps),
    llmName: "scripted",
    profile,
    trials: 2,
    ...extra,
  });

describe("runSuite / summarize", () => {
  it("computes pass@1, pass^k, tool-call accuracy, and safety violations", async () => {
    const report = await suite(STEPS);
    expect(report.cases.map((c) => [c.id, c.status, c.passRate, c.passHatK])).toEqual([
      ["l1-crisis-988", "pass", 1, true],
      ["l1-emergency-911", "fail", 0.5, false],
      ["l1-book-after-explicit-yes", "fail", 0.5, false],
    ]);
    expect(report.summary).toMatchObject({
      cases: 3,
      ran: 3,
      passed: 1,
      failed: 2,
      passAt1: (1 + 0.5 + 0.5) / 3,
      passHatK: 1 / 3,
      toolCallAccuracy: 5 / 6,
      safetyViolations: 1,
    });
    expect(report.summary.costUsd).toBeCloseTo(
      6 *
        estimateCostUsd(profile, {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      10,
    );
  });

  it("the budget guard stops starting trials once spend reaches --max-cost", async () => {
    const perCall = estimateCostUsd(profile, {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const report = await suite(STEPS, { maxCostUsd: perCall * 2.5 }); // three calls, then stop
    expect(report.cases.map((c) => c.trials.length)).toEqual([2, 1, 0]);
    expect(report.cases[2]?.status).toBe("skip");
    expect(report.maxCostUsd).toBe(perCall * 2.5);
  });

  it("latency percentiles come from the trials that ran", () => {
    const trial = (durationMs: number) => ({
      trial: 1,
      status: "pass" as const,
      graders: [],
      safetyViolations: 0,
      costUsd: 0,
      durationMs,
    });
    const s = summarize("l1", [
      {
        id: "a",
        category: "l1",
        tags: [],
        status: "pass",
        passRate: 1,
        passHatK: true,
        trials: [10, 20, 30, 40, 1000].map(trial),
      },
    ]);
    expect(s.latencyMs).toEqual({ p50: 30, p95: 1000 });
  });

  it("the markdown summary lists metrics and every failed check", async () => {
    const md = markdownSummary(await suite(STEPS));
    expect(md).toContain("pass@1 67% · pass^k 33% · tool-call accuracy 83% · safety violations 1");
    expect(md).toMatch(/\| l1-emergency-911 \| fail \| 50% \| invariant\.no_reasoning_leak: /);
    expect(md).toMatch(/\| l1-book-after-explicit-yes \| fail \| 50% \| l1\.action: responded instead/);
  });
});
