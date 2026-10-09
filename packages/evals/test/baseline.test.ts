/**
 * Baselines (#34): the file built from two smoke results files (r1/A-1, r1/A-2), its Prettier-stable text, the
 * `--update-baseline` and `--exit-report` steps, and the per-case, per-mode comparison the CI gate uses
 * (r1/Q-1 (a)) at 0, 1 and 2 regressions.
 */
import { format } from "prettier";
import { describe, expect, it } from "vitest";

import {
  baselineFromReports,
  baselineJson,
  CliArgError,
  compareMode,
  exitReportStep,
  parseBaseline,
  resultsStep,
  updateBaselineStep,
  type BaselineMode,
  type ResultsStepDeps,
} from "../src";
import { fakeReport, passing } from "./report-helpers";

const l1 = fakeReport("l1", [
  { id: "l1-a", trials: [{ status: "pass", costUsd: 0.01 }] },
  { id: "l1-b", trials: [{ status: "fail", costUsd: 0.02 }] },
]);
const scenario = fakeReport(
  "scenario",
  [
    { id: "book-a", trials: [{ status: "pass", costUsd: 0.05, simulatorCostUsd: 0.02 }] },
    { id: "safety-a", category: "safety", trials: [{ status: "skip", reason: "covered" }] },
  ],
  { startedAt: "2026-10-09T12:01:00.000Z" },
);

describe("baselineFromReports (r1/A-1, r1/A-2)", () => {
  it("records each mode's statuses, model, prompt, date, passed count, safety and agent-share cost", () => {
    const b = baselineFromReports([scenario, l1]);
    expect(b).toEqual({
      schemaVersion: 1,
      profile: "sonnet-4.6",
      suite: "smoke",
      trialsPerCase: 1,
      modes: {
        l1: {
          modelId: "us.anthropic.claude-sonnet-4-6",
          promptVersion: "system.v1",
          recordedAt: "2026-10-09T12:00:00.000Z",
          cases: 2,
          passed: 1,
          safetyViolations: 0,
          agentCostUsd: 0.03,
          statuses: { "l1-a": "pass", "l1-b": "fail" },
        },
        scenario: {
          modelId: "us.anthropic.claude-sonnet-4-6",
          promptVersion: "system.v1",
          recordedAt: "2026-10-09T12:01:00.000Z",
          cases: 2,
          passed: 1,
          safetyViolations: 0,
          agentCostUsd: 0.03,
          statuses: { "book-a": "pass", "safety-a": "skip" },
        },
      },
    });
    expect(parseBaseline(JSON.parse(baselineJson(b)), "b.json")).toEqual(b);
  });

  it.each([
    [[l1, l1], "need one l1 and one scenario results file, got l1, l1"],
    [[l1, { ...scenario, suite: "full" as const }], "scenario: suite full, not smoke"],
    [[{ ...l1, trialsPerCase: 3 }, scenario], "l1: 3 trials per case, not 1"],
    [[l1, { ...scenario, profile: "haiku-4.5" }], "profiles differ: sonnet-4.6, haiku-4.5"],
    [
      [l1, { ...scenario, summary: { ...scenario.summary, budgetStopped: 1 } }],
      "scenario: the budget guard stopped 1 case(s)",
    ],
  ])("refuses %#: %s", (reports, message) => {
    expect(() => baselineFromReports(reports)).toThrow(message);
  });

  it("writes JSON Prettier leaves as it is (2-space indent, trailing newline)", async () => {
    const text = baselineJson(baselineFromReports([l1, scenario]));
    expect(await format(text, { parser: "json" })).toBe(text);
  });
});

describe("the results-file steps (#34)", () => {
  const files = new Map<string, unknown>([
    ["/l1.json", JSON.parse(JSON.stringify(l1))],
    ["/scenario.json", JSON.parse(JSON.stringify(scenario))],
    ["/bad.json", { mode: "l1" }],
  ]);
  const deps = () => {
    const written = new Map<string, string>();
    const log: string[] = [];
    const d: ResultsStepDeps = {
      readJson: (p) => files.get(p),
      writeFile: (p, t) => written.set(p, t),
      log: (l) => log.push(l),
    };
    return { d, written, log };
  };

  it("the command line's results step runs --exit-report or --update-baseline on its two files", () => {
    const exit = deps();
    resultsStep(
      {
        out: "/out",
        baselineDir: "/b",
        resultsStep: { action: "exit", files: ["/l1.json", "/scenario.json"] },
      },
      exit.d,
    );
    expect([...exit.written.keys()]).toEqual([
      "/out/2026-10-09T120100Z-exit-sonnet-4.6.json",
      "/out/2026-10-09T120100Z-exit-sonnet-4.6.md",
    ]);
    const base = deps();
    resultsStep(
      {
        out: "/out",
        baselineDir: "/b",
        resultsStep: { action: "baseline", files: ["/l1.json", "/scenario.json"] },
      },
      base.d,
    );
    expect([...base.written.keys()]).toEqual(["/b/sonnet-4.6.json"]);
  });

  it("--update-baseline writes <baselineDir>/<profile>.json", () => {
    const { d, written, log } = deps();
    updateBaselineStep({ baselineDir: "/b", files: ["/scenario.json", "/l1.json"] }, d);
    expect([...written.keys()]).toEqual(["/b/sonnet-4.6.json"]);
    expect(parseBaseline(JSON.parse(written.get("/b/sonnet-4.6.json") ?? ""), "x").modes.l1.passed).toBe(1);
    expect(log).toEqual(["evals: wrote /b/sonnet-4.6.json: l1 1/2 passed, scenario 1/2 passed"]);
  });

  it("--exit-report writes the table next to the results, stamped by the scenario run", () => {
    const { d, written } = deps();
    const r = exitReportStep({ out: "/out", files: ["/l1.json", "/scenario.json"] }, d);
    expect(r.profile).toBe("sonnet-4.6");
    expect([...written.keys()]).toEqual([
      "/out/2026-10-09T120100Z-exit-sonnet-4.6.json",
      "/out/2026-10-09T120100Z-exit-sonnet-4.6.md",
    ]);
    expect(written.get("/out/2026-10-09T120100Z-exit-sonnet-4.6.md")).toContain(
      "# PRD §7 exit metrics: sonnet-4.6",
    );
  });

  it("a missing, unreadable or malformed file, or files that don't fit the step, are usage errors", () => {
    const { d } = deps();
    const step = (f: [string, string]) => () => updateBaselineStep({ baselineDir: "/b", files: f }, d);
    expect(step(["/l1.json", "/none.json"])).toThrow(new CliArgError("/none.json doesn't exist"));
    expect(step(["/l1.json", "/bad.json"])).toThrow(CliArgError);
    expect(step(["/l1.json", "/bad.json"])).toThrow(/^\/bad\.json isn't an eval results file/);
    expect(step(["/l1.json", "/l1.json"])).toThrow(
      new CliArgError("not a baseline: need one l1 and one scenario results file, got l1, l1"),
    );
    const throwing: ResultsStepDeps = {
      ...d,
      readJson: () => {
        throw new Error("EACCES");
      },
    };
    expect(() => exitReportStep({ out: "/o", files: ["/a", "/b"] }, throwing)).toThrow(
      new CliArgError("/a: Error: EACCES"),
    );
    expect(() => exitReportStep({ out: "/o", files: ["/l1.json", "/l1.json"] }, d)).toThrow(CliArgError);
  });
});

describe("compareMode (r1/Q-1 (a))", () => {
  const base: BaselineMode = {
    modelId: "m",
    promptVersion: "p",
    recordedAt: "t",
    cases: 5,
    passed: 4,
    safetyViolations: 0,
    agentCostUsd: 0.1,
    statuses: { a: "pass", b: "pass", c: "pass", d: "fail", s: "skip", gone: "pass" },
  };
  const now = (statuses: Record<string, "pass" | "fail" | "error" | "skip">) => ({
    modelId: "m",
    promptVersion: "p",
    statuses,
  });

  it("0 regressions passes", () => {
    const c = compareMode("l1", base, now({ a: "pass", b: "pass", c: "pass", d: "pass", s: "fail" }));
    expect(c).toMatchObject({ regressions: [], failed: false, warnings: [] });
  });

  it("exactly 1 regression passes; an error counts as not passing", () => {
    const c = compareMode("l1", base, now({ a: "error", b: "pass", c: "pass", d: "fail", s: "fail" }));
    expect(c).toMatchObject({ regressions: ["a"], failed: false });
  });

  it("2 regressions fail", () => {
    const c = compareMode("scenario", base, now({ a: "fail", b: "error", c: "pass", d: "fail", s: "pass" }));
    expect(c).toMatchObject({ mode: "scenario", regressions: ["a", "b"], failed: true });
  });

  it("skipped in the baseline, missing now, and new cases are listed and not counted", () => {
    const c = compareMode(
      "l1",
      base,
      now({ a: "pass", b: "pass", c: "pass", d: "fail", s: "fail", fresh: "fail" }),
    );
    expect(c.regressions).toEqual([]);
    expect(c.rows.filter((r) => r.note !== undefined).map((r) => [r.id, r.note])).toEqual([
      ["fresh", "new since the baseline; not counted"],
      ["gone", "not in this run; not counted"],
      ["s", "skipped in the baseline; not counted"],
    ]);
  });

  it("a different model ID or prompt version is a warning, and the comparison still runs", () => {
    const c = compareMode("l1", base, {
      modelId: "m2",
      promptVersion: "p2",
      statuses: { a: "fail", b: "fail" },
    });
    expect(c.warnings).toEqual(["model ID m2, baseline m", "prompt version p2, baseline p"]);
    expect(c.failed).toBe(true);
  });
});

describe("baselines seeded from smoke runs", () => {
  it("a run of n passing cases has n passed", () => {
    const b = baselineFromReports([
      fakeReport("l1", passing("l1", 3)),
      fakeReport("scenario", passing("s", 2)),
    ]);
    expect([b.modes.l1.passed, b.modes.scenario.passed]).toEqual([3, 2]);
  });
});
