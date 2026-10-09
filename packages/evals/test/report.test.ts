/**
 * The report's metrics (#34): agent cost per completed conversation (r1/Q-5 (b)), turns per conversation
 * (r1/A-10), each run's half of the PRD §7 exit metrics, the exit table from two results files (r1/Q-4 (a),
 * r1/Q-7 (a)), the judge rubric average (r1/A-11), and the markdown's new lines and drill-down.
 */
import { describe, expect, it } from "vitest";

import {
  agentCostUsd,
  conversationMetrics,
  emergencyMet,
  exitHalf,
  exitMarkdown,
  EXIT_TOLERANCE,
  exitMet,
  exitReport,
  markdownSummary,
  parseRunReport,
  percentile,
  reaches,
  summarizeJudge,
  within,
  type RunReport,
} from "../src";
import { fakeReport, scenarioTrial, type FakeCase } from "./report-helpers";

describe("conversationMetrics (r1/Q-5 (b), r1/A-10)", () => {
  const trials = [
    scenarioTrial({
      status: "pass",
      stoppedBecause: "goal_achieved",
      turns: 3,
      costUsd: 0.05,
      simulatorCostUsd: 0.01,
    }),
    // Completion is the stop reason only: a failed trial that ended `escalated` is completed.
    scenarioTrial({
      status: "fail",
      stoppedBecause: "escalated",
      turns: 5,
      costUsd: 0.07,
      simulatorCostUsd: 0.02,
    }),
    scenarioTrial({
      status: "fail",
      stoppedBecause: "gave_up",
      turns: 8,
      costUsd: 0.1,
      simulatorCostUsd: 0.03,
    }),
    // An error trial is never completed, whatever its stop reason, but its spend counts.
    scenarioTrial({
      status: "error",
      stoppedBecause: "goal_achieved",
      turns: 1,
      costUsd: 0.02,
      simulatorCostUsd: 0,
    }),
    scenarioTrial({ status: "skip", turns: 0, costUsd: 0 }),
  ];

  it("charges every trial's agent share to the completed ones", () => {
    const m = conversationMetrics(trials);
    expect(m.trials).toBe(4);
    expect(m.completed).toBe(2);
    expect(m.agentCostUsd).toBeCloseTo(0.04 + 0.05 + 0.07 + 0.02, 12);
    expect(m.agentCostPerCompletedUsd).toBeCloseTo((0.04 + 0.05 + 0.07 + 0.02) / 2, 12);
  });

  it("counts turns over completed conversations only", () => {
    expect(conversationMetrics(trials).turns).toEqual({ mean: 4, p95: 5 });
  });

  it("percentile is the nearest rank, p0 the smallest value", () => {
    expect([0, 50, 95, 100].map((p) => percentile([3, 1, 2], p))).toEqual([1, 2, 3, 3]);
    expect(percentile([], 95)).toBe(0);
  });

  it("is n/a, not 0, with no completed conversation", () => {
    const m = conversationMetrics([trials[2], trials[3]].filter((t) => t !== undefined));
    expect(m.completed).toBe(0);
    expect(m.agentCostPerCompletedUsd).toBeUndefined();
    expect(m.turns).toBeUndefined();
  });

  it("the agent share leaves out the simulator", () => {
    expect(agentCostUsd(scenarioTrial({ status: "pass", costUsd: 0.3, simulatorCostUsd: 0.1 }))).toBeCloseTo(
      0.2,
      12,
    );
  });
});

const coreAndSafety: FakeCase[] = [
  { id: "book-a", category: "book", trials: [{ status: "pass" }, { status: "pass" }, { status: "pass" }] },
  { id: "book-b", category: "book", trials: [{ status: "pass" }, { status: "error" }, { status: "pass" }] },
  {
    id: "clarify-a",
    category: "clarify",
    trials: [{ status: "fail" }, { status: "pass" }, { status: "pass" }],
  },
  {
    id: "safety-a",
    category: "safety",
    tags: ["emergency"],
    trials: [{ status: "pass" }, { status: "pass" }, { status: "pass" }],
  },
  {
    id: "skip-a",
    category: "escalate",
    trials: [{ status: "skip", reason: "covered outside the harness: x" }],
  },
  {
    id: "skip-b",
    category: "escalate",
    trials: [],
    reason: "budget guard ($1 reached) after 0 of 3 trial(s)",
  },
  { id: "skip-c", category: "escalate", trials: [{ status: "skip" }] },
];

describe("exitHalf", () => {
  const report = fakeReport("scenario", coreAndSafety, { trialsPerCase: 3 });
  const h = exitHalf("scenario", 3, report.cases, report.summary.safetyViolations);

  it("task success is the mean pass rate over core cases that ran; a case with an errored trial stays in the denominator", () => {
    expect(h.taskSuccess).toBeCloseTo((1 + 2 / 3 + 2 / 3) / 3, 12);
  });

  it("reliability is the share of core cases with every trial passing", () => {
    expect(h.reliability).toBeCloseTo(1 / 3, 12);
  });

  it("reports each core category, n/a for one with no runnable case", () => {
    expect(h.byCategory.map((c) => [c.category, c.cases, c.taskSuccess])).toEqual([
      ["book", 2, (1 + 2 / 3) / 2],
      ["reschedule", 0, undefined],
      ["availability", 0, undefined],
      ["escalate", 0, undefined],
      ["clarify", 1, 2 / 3],
    ]);
  });

  it("lists skipped cases with their reasons, and the emergency cases", () => {
    expect(h.skipped).toEqual([
      { id: "skip-a", reason: "covered outside the harness: x" },
      { id: "skip-b", reason: "budget guard ($1 reached) after 0 of 3 trial(s)" },
      { id: "skip-c", reason: "skipped" },
    ]);
    expect(h.emergency).toEqual({ ids: ["safety-a"], passedEvery: ["safety-a"] });
    expect(emergencyMet(h)).toBe(true);
  });

  it("an L1 half has no task success or reliability, and zero emergency cases isn't met", () => {
    const l1 = fakeReport("l1", [{ id: "l1-a", trials: [{ status: "pass" }] }]);
    const half = exitHalf("l1", 1, l1.cases, 0);
    expect(half.taskSuccess).toBeUndefined();
    expect(half.reliability).toBeUndefined();
    expect(emergencyMet(half)).toBe(false);
  });
});

const full = { suite: "full" as const, trialsPerCase: 3 };
const exitPair = (l1Cases: FakeCase[], scenarioCases: FakeCase[], extra = {}): [RunReport, RunReport] => [
  fakeReport("scenario", scenarioCases, { ...full, ...extra }),
  fakeReport("l1", l1Cases, full),
];
const goodCore: FakeCase[] = ["book", "reschedule", "availability", "escalate", "clarify"].map(
  (category) => ({
    id: `${category}-a`,
    category,
    trials: [
      { status: "pass", stoppedBecause: "goal_achieved", costUsd: 0.1, simulatorCostUsd: 0.04 },
      { status: "pass", stoppedBecause: "goal_achieved", costUsd: 0.1, simulatorCostUsd: 0.04 },
      { status: "pass", stoppedBecause: "goal_achieved", costUsd: 0.1, simulatorCostUsd: 0.04 },
    ],
  }),
);
const emergencyScenario: FakeCase = {
  id: "safety-911",
  category: "safety",
  tags: ["emergency"],
  trials: [{ status: "pass" }, { status: "pass" }, { status: "pass" }],
};
const emergencyL1: FakeCase = {
  id: "l1-911",
  tags: ["smoke", "emergency"],
  trials: [{ status: "pass" }, { status: "pass" }, { status: "pass" }],
};

const judgedCore: FakeCase[] = goodCore.map((c) => ({
  ...c,
  trials: c.trials.map((t) => ({
    ...t,
    graders: [
      { kind: "judge" as const, name: "judge.tone", status: "pass" as const, safety: false, score: 5 },
      { kind: "judge" as const, name: "judge.clarity", status: "pass" as const, safety: false, score: 4 },
    ],
  })),
}));

describe("exitReport (r1/Q-4 (a))", () => {
  it("an exit run with every target met", () => {
    const r = exitReport(exitPair([emergencyL1], [...goodCore, emergencyScenario]));
    expect(r.notExitRun).toEqual([]);
    expect(r.rows.find((x) => x.metric.startsWith("Task success"))).toMatchObject({
      value: "100%",
      verdict: "met",
    });
    expect(r.rows.find((x) => x.metric.startsWith("Reliability"))).toMatchObject({
      metric: "Reliability, scenario mode, core categories, pass^3",
      verdict: "met",
    });
    expect(r.rows.find((x) => x.metric.startsWith("Emergency"))).toMatchObject({
      value: "l1 1/1, scenario 1/1",
      verdict: "met",
    });
    // Agent cost per completed conversation: $0.06 agent share each, every trial completed.
    expect(r.rows.find((x) => x.metric.startsWith("Agent cost"))).toMatchObject({
      value: "$0.0600",
      verdict: "met",
    });
    expect(r.rows.find((x) => x.metric.startsWith("Judge–human"))?.verdict).toBe("measured elsewhere");
    expect(r.rows.find((x) => x.metric.startsWith("Judge rubric"))?.metric).toBe(
      "Judge rubric average (tone, clarity), before calibration (#159)",
    );
    expect(r.rows.find((x) => x.metric.startsWith("NFR-001"))).toMatchObject({
      verdict: "measured elsewhere",
    });
    expect(exitMarkdown(r)).toContain(
      "\n\nExit run: full suite, 3 trials per case, both modes, simulator `sonnet-4.6`, no budget stop.\n\n",
    );
    expect(exitMet(r)).toBe(false); // the judge was off in this fixture: its rubric average is n/a
  });

  it("sums safety violations over both modes", () => {
    const l1 = { ...emergencyL1, trials: emergencyL1.trials.map((t) => ({ ...t, safetyViolations: 1 })) };
    const unsafe = {
      ...emergencyScenario,
      trials: emergencyScenario.trials.map((t, i) => ({ ...t, safetyViolations: i === 0 ? 2 : 0 })),
    };
    const r = exitReport(exitPair([l1], [...goodCore, unsafe]));
    expect(r.rows.find((x) => x.metric.startsWith("Safety"))).toMatchObject({
      value: "5 (l1 3, scenario 2)",
      verdict: "not met",
    });
    // Scenario-mode violations alone fail the metric too.
    const scenarioOnly = exitReport(exitPair([emergencyL1], [...goodCore, unsafe]));
    expect(scenarioOnly.rows.find((x) => x.metric.startsWith("Safety"))).toMatchObject({
      value: "2 (l1 0, scenario 2)",
      verdict: "not met",
    });
  });

  it("the emergency metric isn't met when L1 has no case tagged emergency (r1/Q-7 (a))", () => {
    const r = exitReport(
      exitPair([{ id: "l1-other", trials: emergencyL1.trials }], [...goodCore, emergencyScenario]),
    );
    expect(r.rows.find((x) => x.metric.startsWith("Emergency"))).toMatchObject({
      value: "l1 0/0, scenario 1/1",
      verdict: "not met",
    });
  });

  it("an emergency case with one failed trial fails the metric", () => {
    const bad = {
      ...emergencyScenario,
      trials: [{ status: "pass" as const }, { status: "fail" as const }, { status: "pass" as const }],
    };
    expect(
      exitReport(exitPair([emergencyL1], [...goodCore, bad])).rows.find((x) =>
        x.metric.startsWith("Emergency"),
      )?.verdict,
    ).toBe("not met");
  });

  it("two files of one mode are refused", () => {
    const l1 = fakeReport("l1", [emergencyL1], full);
    expect(() => exitReport([l1, l1])).toThrow(
      "the exit report needs one l1 and one scenario results file, got l1 and l1",
    );
  });

  it("still computes the table when the pair isn't an exit run, and lists each failed precondition; the files are told apart by mode, not order", () => {
    const scenario = fakeReport("scenario", [...goodCore, { ...emergencyScenario, budgetStopped: true }], {
      suite: "smoke",
      trialsPerCase: 1,
      profile: "haiku-4.5",
      promptVersion: "system.v2",
      simulator: "replay:x",
    });
    const l1 = fakeReport("l1", [emergencyL1], full);
    const r = exitReport([l1, scenario]);
    expect(r.notExitRun).toEqual([
      "scenario: suite is smoke, not full",
      "scenario: 1 trial(s) per case, not 3",
      "scenario: the budget guard stopped 1 case(s)",
      "scenario: simulator is replay:x, not the LLM simulator on sonnet-4.6",
      "profiles differ: l1 sonnet-4.6, scenario haiku-4.5",
      "prompt versions differ: l1 system.v1, scenario system.v2",
    ]);
    expect(r.rows.find((x) => x.metric.startsWith("Reliability"))?.metric).toContain("pass^k (k=1)");
    const md = exitMarkdown(r);
    expect(md).toContain("**Not an exit run:**\n- scenario: suite is smoke, not full");
    expect(exitMet(r)).toBe(false);
  });

  it("lists the L1 run's skipped cases too", () => {
    const cut: FakeCase = {
      id: "l1-cut",
      trials: [],
      budgetStopped: true,
      reason: "budget guard ($1 reached) after 0 of 3 trial(s)",
    };
    const r = exitReport(exitPair([emergencyL1, cut], [...goodCore, emergencyScenario]));
    expect(exitMarkdown(r)).toContain(
      "\n\nSkipped in l1 (left out of the denominators):\n- l1-cut: budget guard ($1 reached) after 0 of 3 trial(s)",
    );
  });

  it("lists skipped cases by ID with their reasons, out of the denominators", () => {
    const skipped: FakeCase = {
      id: "escalate-api",
      category: "escalate",
      trials: [{ status: "skip", reason: "covered outside" }],
    };
    const r = exitReport(exitPair([emergencyL1], [...goodCore, emergencyScenario, skipped]));
    expect(r.rows.find((x) => x.metric.startsWith("↳ escalate"))).toMatchObject({
      metric: "↳ escalate (1 case(s))",
      value: "100%",
    });
    expect(exitMarkdown(r)).toContain(
      "| diagnostic |\n\nSkipped in scenario (left out of the denominators):\n- escalate-api: covered outside",
    );
  });

  it("cost per completed conversation counts every category's spend, the safety cases' included", () => {
    const dear = {
      ...emergencyScenario,
      trials: emergencyScenario.trials.map((t) => ({ ...t, costUsd: 0.4 })),
    };
    const r = exitReport(exitPair([emergencyL1], [...goodCore, dear]));
    // 15 core trials at $0.06 and 3 safety trials at $0.40 (no simulator), over 15 completed core trials.
    expect(r.rows.find((x) => x.metric.startsWith("Agent cost"))?.value).toBe(
      `$${((15 * 0.06 + 3 * 0.4) / 15).toFixed(4)}`,
    );
  });

  it("an exit run with the judge on and every target met meets §7", () => {
    const r = exitReport(exitPair([emergencyL1], [...judgedCore, emergencyScenario]));
    expect(r.rows.find((x) => x.metric.startsWith("Judge rubric"))).toMatchObject({
      value: "4.50 / 5",
      verdict: "met",
    });
    expect(exitMet(r)).toBe(true);
  });

  it("the simulator must be the LLM simulator on sonnet-4.6, not another profile's", () => {
    const r = exitReport(
      exitPair([emergencyL1], [...goodCore, emergencyScenario], { simulator: "llm:haiku-4.5:sim.v1" }),
    );
    expect(r.notExitRun).toEqual([
      "scenario: simulator is llm:haiku-4.5:sim.v1, not the LLM simulator on sonnet-4.6",
    ]);
  });

  it("a rate at exactly its target meets it, though the mean picks up float error (cddafdb/TEST-101)", () => {
    const trials = (passes: number) =>
      [0, 1, 2].map((i) => ({
        status: i < passes ? ("pass" as const) : ("fail" as const),
        stoppedBecause: "goal_achieved",
      }));
    const categories = ["book", "reschedule", "availability", "escalate", "clarify"];
    // 17 cases at 3/3, then 3 at 1/3: 54 of 60 trials, exactly 90%.
    const ninety = Array.from({ length: 20 }, (_, i) => ({
      id: `core-${i}`,
      category: categories[i % 5] ?? "book",
      trials: trials(i < 17 ? 3 : 1),
    }));
    const r = exitReport(exitPair([emergencyL1], [...ninety, emergencyScenario]));
    expect(r.halves.scenario.taskSuccess).toBe(0.8999999999999998);
    expect(r.rows.find((x) => x.metric.startsWith("Task success"))).toMatchObject({
      value: "90%",
      verdict: "met",
    });
    // 4 of 5 core cases with every trial passing: exactly 80%.
    const eighty = categories.map((category, i) => ({
      id: `r-${i}`,
      category,
      trials: trials(i < 4 ? 3 : 2),
    }));
    const r2 = exitReport(exitPair([emergencyL1], [...eighty, emergencyScenario]));
    expect(r2.rows.find((x) => x.metric.startsWith("Reliability"))).toMatchObject({
      value: "80%",
      verdict: "met",
    });
  });

  it("the tolerance absorbs float error only, far below one trial's step", () => {
    expect(reaches(0.8999999999999998, 0.9)).toBe(true);
    expect(reaches(0.9 - 1 / 90, 0.9)).toBe(false);
    expect(within(0.25000000000000006, 0.25)).toBe(true);
    expect(within(0.2501, 0.25)).toBe(false);
    expect(EXIT_TOLERANCE).toBeLessThan(1 / 90 / 1000);
  });

  it("a share below its target is not met", () => {
    const failing = goodCore.map((c, i) =>
      i < 2
        ? {
            ...c,
            trials: [c.trials[0], { status: "fail" as const }, c.trials[2]].filter((t) => t !== undefined),
          }
        : c,
    );
    const r = exitReport(exitPair([emergencyL1], [...failing, emergencyScenario]));
    expect(r.rows.find((x) => x.metric.startsWith("Task success"))).toMatchObject({
      value: "87%",
      verdict: "not met",
    });
    expect(r.rows.find((x) => x.metric.startsWith("Reliability"))).toMatchObject({
      value: "60%",
      verdict: "not met",
    });
    expect(exitMet(r)).toBe(false);
  });

  it("every target met still isn't an exit when a precondition fails", () => {
    const pair = exitPair([emergencyL1], [...judgedCore, emergencyScenario], { suite: "smoke" });
    const r = exitReport(pair);
    expect(r.rows.filter((x) => x.verdict === "not met" || x.verdict === "n/a")).toEqual([]);
    expect(exitMet(r)).toBe(false);
  });

  it("a core category with no runnable case shows n/a without failing the headline", () => {
    const r = exitReport(
      exitPair([emergencyL1], [...judgedCore.filter((c) => c.category !== "reschedule"), emergencyScenario]),
    );
    expect(r.rows.find((x) => x.metric.startsWith("↳ reschedule"))).toMatchObject({
      value: "n/a",
      verdict: "n/a",
    });
    expect(exitMet(r)).toBe(true);
  });
});

describe("exitReport's other verdicts", () => {
  it("no simulator recorded is a failed precondition", () => {
    const [scenario, l1] = exitPair([emergencyL1], [...goodCore, emergencyScenario]);
    const { simulator: _simulator, ...noSimulator } = scenario;
    expect(exitReport([l1, noSimulator]).notExitRun).toEqual([
      "scenario: simulator is none, not the LLM simulator on sonnet-4.6",
    ]);
  });

  it("a low judge average, a dear conversation, and none completed are not met or n/a", () => {
    const low = judgedCore.map((c) => ({
      ...c,
      trials: c.trials.map((t) => ({
        ...t,
        costUsd: 1,
        simulatorCostUsd: 0,
        graders: (t.graders ?? []).map((g) => ({ ...g, score: 3 })),
      })),
    }));
    const r = exitReport(exitPair([emergencyL1], [...low, emergencyScenario]));
    expect(r.rows.find((x) => x.metric.startsWith("Judge rubric"))).toMatchObject({
      value: "3.00 / 5",
      verdict: "not met",
    });
    expect(r.rows.find((x) => x.metric.startsWith("Agent cost"))).toMatchObject({ verdict: "not met" });
    const gaveUp = goodCore.map((c) => ({
      ...c,
      trials: c.trials.map((t) => ({ ...t, stoppedBecause: "gave_up" })),
    }));
    expect(
      exitReport(exitPair([emergencyL1], gaveUp)).rows.find((x) => x.metric.startsWith("Agent cost")),
    ).toMatchObject({
      value: "n/a",
      verdict: "n/a",
    });
  });

  it("an L1 report without tool-call accuracy shows n/a", () => {
    const [scenario, l1] = exitPair([emergencyL1], [...goodCore, emergencyScenario]);
    const { toolCallAccuracy: _accuracy, ...summary } = l1.summary;
    expect(exitReport([{ ...l1, summary }, scenario]).rows.at(-1)).toMatchObject({
      value: "n/a",
      verdict: "diagnostic",
    });
  });
});

describe("summarizeJudge's rubric average (r1/A-11)", () => {
  const judged = (dimension: string, score: number) =>
    scenarioTrial({
      status: "pass",
      graders: [
        {
          kind: "judge",
          name: `judge.${dimension}`,
          status: score >= 4 ? "pass" : "fail",
          safety: false,
          score,
        },
      ],
    });

  it("is the mean of the tone mean and the clarity mean, not the pooled mean", () => {
    const j = summarizeJudge(
      [judged("tone", 5), judged("tone", 5), judged("tone", 5), judged("clarity", 2)],
      [],
    );
    expect(j.rubricAverage).toBeCloseTo((5 + 2) / 2, 12); // pooled would be 17/4
  });

  it("is the one mean when only one dimension was scored", () => {
    expect(summarizeJudge([judged("clarity", 3)], []).rubricAverage).toBe(3);
  });
});

describe("markdownSummary (#34)", () => {
  it("a scenario run shows the conversations, its §7 half and a per-scenario drill-down", () => {
    const report = fakeReport("scenario", [
      {
        id: "book-a",
        category: "book",
        trials: [
          {
            status: "pass",
            stoppedBecause: "goal_achieved",
            turns: 3,
            costUsd: 0.05,
            simulatorCostUsd: 0.01,
            graders: [
              { kind: "judge", name: "judge.tone", status: "pass", safety: false, score: 5 },
              { kind: "judge", name: "judge.clarity", status: "pass", safety: false, score: 4 },
              { kind: "judge", name: "judge.urgency", status: "skip", safety: false },
              { kind: "invariant", name: "invariant.score_like", status: "pass", safety: false, score: 3 },
            ],
          },
        ],
      },
      {
        id: "safety-911",
        category: "safety",
        tags: ["emergency"],
        trials: [{ status: "fail", stoppedBecause: "gave_up", turns: 2, reason: "a | b" }],
      },
      {
        id: "book-cut",
        category: "book",
        trials: [],
        budgetStopped: true,
        reason: "budget guard ($1 reached) after 0 of 1 trial(s)",
      },
    ]);
    const md = markdownSummary(report);
    expect(md).toContain(
      "- Conversations: 1 of 2 completed (`goal_achieved` or `escalated`) · turns per conversation mean 3.0, p95 3 · agent cost per completed conversation $0.0400 (agent share $0.0400 over every trial)",
    );
    expect(md).toContain(
      "- Core categories: task success 100% (book 100%, reschedule n/a, availability n/a, escalate n/a, clarify n/a) · reliability 100% (all 1 trial(s) passing)",
    );
    expect(md).toContain("- Emergency cases (tagged `emergency`): 0/1 passed every trial (not met)");
    expect(md).toContain("## Per-scenario drill-down\n\n### book-a (book, pass)");
    expect(md).toContain("| 1 | pass | goal_achieved | 3 | $0.0400 |  | tone 5, clarity 4 |");
    expect(md).toContain("| 1 | fail | gave_up | 2 | $0.0000 | a \\| b |  |");
    expect(md).toContain("### book-cut (book, skip)\n\n| Trial |");
    expect(md).toContain("|---|---|---|---|---|---|---|\n\nbudget guard ($1 reached) after 0 of 1 trial(s)");
  });

  it("an L1 run shows its emergency cases and no drill-down", () => {
    const md = markdownSummary(
      fakeReport("l1", [{ id: "l1-911", tags: ["emergency"], trials: [{ status: "pass" }] }]),
    );
    expect(md).toContain("- Emergency cases (tagged `emergency`): 1/1 passed every trial");
    expect(md).not.toContain("drill-down");
    expect(md).not.toContain("Core categories");
    expect(md).not.toContain("Conversations:");
  });
});

describe("parseRunReport", () => {
  it("accepts a results file and names the path and fields of one it can't read", () => {
    const report = fakeReport("l1", [{ id: "l1-a", trials: [{ status: "pass" }] }]);
    expect(parseRunReport(JSON.parse(JSON.stringify(report)), "r.json").cases[0]?.id).toBe("l1-a");
    expect(() => parseRunReport({ ...report, mode: "both" }, "r.json")).toThrow(
      /^r\.json isn't an eval results file: mode: /,
    );
  });

  it("refuses a file without the summary's passed count, or a scenario trial without its simulator cost", () => {
    const l1 = JSON.parse(
      JSON.stringify(fakeReport("l1", [{ id: "l1-a", trials: [{ status: "pass" }] }])),
    ) as RunReport;
    const { passed: _passed, ...summary } = l1.summary;
    expect(() => parseRunReport({ ...l1, summary }, "a.json")).toThrow(
      /^a\.json isn't an eval results file: summary\.passed: /,
    );
    const sc = JSON.parse(
      JSON.stringify(fakeReport("scenario", [{ id: "s-a", trials: [{ status: "pass" }] }])),
    ) as RunReport;
    expect(parseRunReport(sc, "b.json").cases).toHaveLength(1);
    const [c] = sc.cases;
    const [t] = c?.trials ?? [];
    const { simulatorCost: _sim, ...noSim } = t as unknown as Record<string, unknown>;
    expect(() => parseRunReport({ ...sc, cases: [{ ...c, trials: [noSim] }] }, "b.json")).toThrow(
      /^b\.json isn't an eval results file: cases\.0\.trials\.0\.simulatorCost: /,
    );
  });

  it("refuses a file without the summary's safety count, or with a status the gate doesn't know", () => {
    const l1 = JSON.parse(
      JSON.stringify(fakeReport("l1", [{ id: "l1-a", trials: [{ status: "pass" }] }])),
    ) as RunReport;
    const { safetyViolations: _safety, ...summary } = l1.summary;
    expect(() => parseRunReport({ ...l1, summary }, "a.json")).toThrow(
      /^a\.json isn't an eval results file: summary\.safetyViolations: /,
    );
    const [c] = l1.cases;
    expect(() => parseRunReport({ ...l1, cases: [{ ...c, status: "passed" }] }, "a.json")).toThrow(
      /^a\.json isn't an eval results file: cases\.0\.status: /,
    );
  });
});
