/**
 * Suite metrics (ADR-008): pass@1, pass^k, tool-call accuracy, safety violations, errored cases, model
 * retries, the budget guard, and the markdown summary, in L1 and scenario mode with a scripted model.
 */
import {
  estimateCostUsd,
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedMalformed,
  scriptedText,
  scriptedToolUse,
  type ScriptedStep,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  interimSystemPrompt,
  markdownSummary,
  runSuite,
  summarize,
  type RateLimitStats,
  type TrialResult,
} from "../src";
import { l1Case, scenario } from "./helpers";

const cases = [
  l1Case("l1-crisis-988"),
  l1Case("l1-emergency-911"),
  l1Case("l1-book-after-explicit-yes"),
] as const;
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

const suite = (
  steps: ScriptedStep[],
  extra: { maxCostUsd?: number; rateLimit?: { readonly stats: RateLimitStats } } = {},
) =>
  runSuite(cases, {
    mode: "l1",
    suite: "smoke",
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
    const budget = perCall * 2.5;
    const report = await suite(STEPS, { maxCostUsd: budget }); // three calls, then stop
    expect(report.cases.map((c) => c.trials.length)).toEqual([2, 1, 0]);
    expect(report.maxCostUsd).toBe(budget);
    // The cut is reported, not just applied (TEST-105 decision): partly-run and unrun cases say so.
    const [full, partial, unrun] = report.cases;
    expect(full?.budgetStopped).toBeUndefined();
    expect(partial).toMatchObject({ status: "pass", passHatK: false, budgetStopped: true });
    expect(partial?.reason).toBe(`budget guard ($${String(budget)} reached) after 1 of 2 trial(s)`);
    expect(unrun).toMatchObject({ status: "skip", budgetStopped: true });
    expect(unrun?.reason).toMatch(/^budget guard .* after 0 of 2 trial\(s\)$/);
    expect(report.summary.budgetStopped).toBe(2);
    const md = markdownSummary(report);
    expect(md).toContain("· budget guard stopped 2 case(s)");
    expect(md).toMatch(/\| l1-book-after-explicit-yes \| skip \| – \| budget guard /);
  });

  it("an errored trial makes the case `error`, counts in summary.errored, and is left out of accuracy", async () => {
    const report = await runSuite([cases[2]], {
      mode: "l1",
      suite: "smoke",
      llm: new ScriptedLlmClient([scriptedText("Booked!"), { error: new Error("throttled") }]),
      llmName: "scripted",
      profile,
      trials: 2,
    });
    expect(report.cases[0]?.trials.map((t) => t.status)).toEqual(["fail", "error"]);
    expect(report.cases[0]?.status).toBe("error"); // error outranks fail
    expect(report.summary).toMatchObject({ errored: 1, failed: 0, toolCallAccuracy: 0 });
    const ok = await runSuite([cases[2]], {
      mode: "l1",
      suite: "smoke",
      llm: new ScriptedLlmClient([BOOK, { error: new Error("throttled") }]),
      llmName: "scripted",
      profile,
      trials: 2,
    });
    expect(ok.summary.toolCallAccuracy).toBe(1); // 1 of 1 graded trial, not 1 of 2
  });

  it("the report's promptVersion is the version the prompt factory builds (runner.test checks the trials get that prompt)", async () => {
    const custom = (now: Date, name: string) => ({ ...interimSystemPrompt(now, name), version: "custom.v7" });
    const report = await runSuite([cases[0]], {
      mode: "l1",
      suite: "smoke",
      llm: new ScriptedLlmClient([scriptedText("Please call or text 988 now.")]),
      llmName: "scripted",
      profile,
      trials: 1,
      systemPrompt: custom,
    });
    expect(report.promptVersion).toBe("custom.v7");
    expect((await suite(STEPS)).promptVersion).toBe("eval-interim.v0");
  });

  it("scenario mode: skips stop after one trial, retries are summed, the simulator is recorded", async () => {
    const report = await runSuite(
      [scenario("safety-emergency-chest-pain-911"), scenario("book-derm-next-week-afternoon")],
      {
        mode: "scenario",
        suite: "smoke",
        llm: new ScriptedLlmClient([
          scriptedMalformed(),
          scriptedMalformed(), // trial 1: one malformed retry
          scriptedText("That could be an emergency. Please call 911 right now."), // trial 2
        ]),
        llmName: "scripted",
        profile,
        trials: 2,
      },
    );
    expect(report.simulator).toBe("script-only");
    const [emergency, unscripted] = report.cases;
    expect(emergency?.trials.map((t) => t.status)).toEqual(["fail", "pass"]);
    expect(unscripted).toMatchObject({ status: "skip" });
    expect(unscripted?.trials).toHaveLength(1); // a skip reason holds for every trial
    expect(report.summary).toMatchObject({ ran: 1, skipped: 1, llmRetries: 1 });
    expect(report.summary.toolCallAccuracy).toBeUndefined();
    expect(markdownSummary(report)).toContain("· model retries 1");
  });

  it("scenario latency comes from per-turn durations, not whole-trial time", () => {
    const trial: TrialResult = {
      kind: "scenario",
      trial: 1,
      status: "pass",
      graders: [],
      safetyViolations: 0,
      events: [],
      turns: 3,
      outcomes: ["completed", "completed", "completed"],
      simulator: "queued",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      llmCalls: 5,
      llmRetries: 2,
      costUsd: 0,
      durationMs: 5000,
      turnDurationsMs: [10, 20, 30],
    };
    const s = summarize("scenario", [
      {
        id: "a",
        category: "book",
        tags: [],
        status: "pass",
        passRate: 1,
        passHatK: true,
        trials: [trial],
      },
    ]);
    expect(s.latencyMs).toEqual({ p50: 20, p95: 30 });
    expect(s.llmRetries).toBe(2);
  });

  it("latency percentiles come from the trials that ran", () => {
    const trial = (durationMs: number) => ({
      kind: "l1" as const,
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

  it("the report snapshots the rate limiter's stats when it is given one (8c21660/SMELL-405)", async () => {
    const stats: RateLimitStats = { calls: 7, retries: 1, throttles: 1 };
    const report = await suite(STEPS, { rateLimit: { stats } });
    stats.calls = 99; // a later call on the shared limiter doesn't change a finished report
    expect(report.rateLimit).toEqual({ calls: 7, retries: 1, throttles: 1 });
    expect(markdownSummary(report)).toContain(" · 7 calls, 1 retries, 1 throttled");
    const without = await suite(STEPS);
    expect(without.rateLimit).toBeUndefined();
    expect(markdownSummary(without)).not.toContain("throttled");
  });
});
