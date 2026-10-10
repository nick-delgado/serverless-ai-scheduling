/**
 * `npm run evals:matrix` offline (#34, FR-042): the cells and their effort overrides (r1/Q-6 (a)), the request
 * each cell sends, the arguments, the estimate, the confirmation before any model call (r1/A-8), the run loop
 * and its shared budget, the run options, and the comparison table.
 */
import { MODEL_PROFILES, profileRequest, ScriptedLlmClient, type ModelProfile } from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  CliArgError,
  exitReport,
  estimateRunCost,
  interimSystemPrompt,
  isL1Case,
  loadScenarios,
  summarizeJudge,
  type Mode,
  type RunReport,
} from "../src";
import {
  asCellReport,
  cellEstimateUsd,
  cellRunOptions,
  confirmMatrix,
  EFFORT_SWITCHES,
  matrixCases,
  matrixCells,
  matrixMarkdown,
  matrixSetup,
  parseMatrixArgs,
  defaultMatrixCapUsd,
  matrixCommand,
  rowValue,
  runMatrix,
  type MatrixCell,
  type MatrixCommandDeps,
} from "../src/matrix";
import { fakeReport } from "./report-helpers";

const cell = (name: string): MatrixCell => {
  const found = matrixCells().find((c) => c.name === name);
  if (found === undefined) throw new Error(`no cell ${name}`);
  return found;
};

describe("matrixCells (r1/Q-6 (a))", () => {
  it("covers the six entitled profiles, with effort levels only where a profile has a switch", () => {
    expect(matrixCells().map((c) => c.name)).toEqual([
      "sonnet-4.6@low",
      "sonnet-4.6",
      "sonnet-4.6@high",
      "haiku-4.5",
      "nova-2-lite",
      "nova-2-lite@medium",
      "nova-2-lite@high",
      "nova-pro",
      "gpt-oss-120b",
      "gpt-oss-120b@medium",
      "gpt-oss-120b@high",
      "gpt-oss-20b",
      "gpt-oss-20b@medium",
      "gpt-oss-20b@high",
    ]);
  });

  it("a profile's default level is the plain profile, unchanged", () => {
    for (const name of ["sonnet-4.6", "nova-2-lite", "gpt-oss-120b", "gpt-oss-20b"] as const) {
      expect(cell(name).profile).toBe(MODEL_PROFILES[name]);
      const sw = EFFORT_SWITCHES[name];
      expect(sw?.apply(MODEL_PROFILES[name].modelFields, sw.default)).toEqual(
        MODEL_PROFILES[name].modelFields,
      );
    }
  });

  it("writes each family's switch into a copy of the profile's modelFields, and the request carries it", () => {
    const fields = (name: string): ModelProfile["modelFields"] =>
      profileRequest(cell(name).profile, interimSystemPrompt(new Date("2026-10-05T13:00:00Z"), "Walter"))
        .modelFields;
    expect(fields("sonnet-4.6@high")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(fields("sonnet-4.6@low")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(fields("nova-2-lite@high")).toEqual({
      reasoningConfig: { type: "enabled", maxReasoningEffort: "high" },
    });
    expect(fields("gpt-oss-20b@medium")).toEqual({ reasoning_effort: "medium" });
    expect(fields("gpt-oss-120b@high")).toEqual({ reasoning_effort: "high" });
    // Sonnet's switch keeps the rest of `output_config`, and adds one where there's none.
    expect(EFFORT_SWITCHES["sonnet-4.6"]?.apply({}, "high")).toEqual({ output_config: { effort: "high" } });
    expect(
      EFFORT_SWITCHES["sonnet-4.6"]?.apply({ output_config: { effort: "medium", keep: 1 } }, "low"),
    ).toEqual({
      output_config: { effort: "low", keep: 1 },
    });
    // The shared profile objects are untouched, and a cell keeps its model ID (one rate-limit bucket).
    expect(MODEL_PROFILES["sonnet-4.6"].modelFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(cell("gpt-oss-20b@high").profile.modelId).toBe(MODEL_PROFILES["gpt-oss-20b"].modelId);
  });
});

describe("parseMatrixArgs", () => {
  it("defaults to every cell, the full suite, 3 trials, asking first", () => {
    const a = parseMatrixArgs([], "/out");
    expect(a).toMatchObject({ suite: "full", trials: 3, yes: false, dryRun: false, out: "/out" });
    expect(a.cells).toHaveLength(14);
    expect(a.maxCostUsd).toBeUndefined();
  });

  it("reads the flags", () => {
    const a = parseMatrixArgs(
      [
        "--cells",
        "haiku-4.5, gpt-oss-20b@high",
        "--suite=smoke",
        "--trials=1",
        "--max-cost=2",
        "--yes",
        "--dry-run",
        "--out=/o",
      ],
      "/out",
    );
    expect(a).toMatchObject({ suite: "smoke", trials: 1, maxCostUsd: 2, yes: true, dryRun: true, out: "/o" });
    expect(a.cells.map((c) => c.name)).toEqual(["haiku-4.5", "gpt-oss-20b@high"]);
  });

  it.each([
    [["--cells=opus-5"], /^--cells: unknown cell opus-5; cells: sonnet-4\.6@low, /],
    [["--suite=nightly"], /^--suite must be smoke or full, got nightly$/],
    [["--trials=0"], /^--trials must be a positive integer$/],
    [["--max-cost=0"], /^--max-cost must be a positive number of USD$/],
    [["--bogus"], /bogus/],
    [["--trials=1.5"], /^--trials must be a positive integer$/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseMatrixArgs(argv, "/out")).toThrow(CliArgError);
    expect(() => parseMatrixArgs(argv, "/out")).toThrow(message);
  });
});

describe("the estimate", () => {
  const loaded = loadScenarios();
  const llm = new ScriptedLlmClient();

  it("a scenario run has the simulator on sonnet-4.6 and the judge on haiku-4.5; an L1 run neither", () => {
    const scenario = matrixSetup(llm, "scenario");
    expect(scenario.simulator.kind === "llm" ? scenario.simulator.profile.name : "").toBe("sonnet-4.6");
    expect(scenario.judging.kind === "llm" ? scenario.judging.profile.name : "").toBe("haiku-4.5");
    const l1 = matrixSetup(llm, "l1");
    expect([l1.simulator.kind, l1.judging.kind]).toEqual(["script-only", "off"]);
  });

  it("a cell's estimate is both runs on its profile, the simulator and judge included", () => {
    const c = cell("haiku-4.5");
    const args = { suite: "full" as const, trials: 3 };
    const scenario = matrixSetup(llm, "scenario");
    expect(cellEstimateUsd(c, loaded, args, llm)).toBeCloseTo(
      estimateRunCost(matrixCases(loaded, "l1", "full"), c.profile, 3) +
        estimateRunCost(
          matrixCases(loaded, "scenario", "full"),
          c.profile,
          3,
          scenario.simulator,
          scenario.judging,
        ),
      12,
    );
  });

  it("each mode's cases are that mode's pool, cut to the suite", () => {
    const l1 = matrixCases(loaded, "l1", "full");
    expect(l1).toHaveLength(loaded.l1.length);
    expect(l1.every(isL1Case)).toBe(true);
    expect(matrixCases(loaded, "l1", "smoke").every((x) => isL1Case(x) && x.tags.includes("smoke"))).toBe(
      true,
    );
    const scenarios = matrixCases(loaded, "scenario", "full");
    expect(scenarios).toHaveLength(loaded.scenarios.length);
    expect(scenarios.some(isL1Case)).toBe(false);
  });
});

describe("confirmMatrix (r1/A-8)", () => {
  const never = () => Promise.reject(new Error("asked"));

  it("--yes goes ahead without asking", async () => {
    await expect(confirmMatrix({ yes: true }, { isTTY: false, ask: never }, 10)).resolves.toBe(true);
  });

  it("off a terminal without --yes it's a usage error, without asking", async () => {
    await expect(confirmMatrix({ yes: false }, { isTTY: false, ask: never }, 10)).rejects.toThrow(
      CliArgError,
    );
  });

  it.each([
    ["y", true],
    ["YES", true],
    ["", false],
    ["n", false],
    ["sure", false],
  ])("on a terminal, %j means %s", async (answer, go) => {
    const questions: string[] = [];
    const ask = (q: string) => {
      questions.push(q);
      return Promise.resolve(answer);
    };
    await expect(confirmMatrix({ yes: false }, { isTTY: true, ask }, 72.444)).resolves.toBe(go);
    expect(questions).toEqual(["Run the matrix at an estimated $72.44? [y/N] "]);
  });
});

/** A run of `cost` in `mode`, with one emergency case and every core category passing, k=3, full suite. */
const runOf = (mode: Mode, cost: number, judgeCost = 0): RunReport => {
  const trials = [1, 2, 3].map(() => ({
    status: "pass" as const,
    stoppedBecause: "goal_achieved",
    costUsd: cost / 3,
    turnDurationsMs: [100, 900],
  }));
  const report = fakeReport(
    mode,
    mode === "l1"
      ? [{ id: "l1-911", tags: ["emergency"], trials }]
      : ["book", "reschedule", "availability", "escalate", "clarify"].map((category) => ({
          id: `${category}-a`,
          category,
          tags: category === "book" ? ["emergency"] : [],
          trials: trials.map((t) => ({ ...t, costUsd: cost / 15 })),
        })),
    { suite: "full", trialsPerCase: 3, wallClockMs: 60_000 },
  );
  return judgeCost === 0
    ? report
    : {
        ...report,
        summary: {
          ...report.summary,
          judge: { ...(report.summary.judge ?? summarizeJudge([], [])), costUsd: judgeCost },
        },
      };
};

describe("runMatrix", () => {
  it("runs each cell's two modes in order, sharing the budget, and builds its exit table", async () => {
    const calls: [string, Mode, number][] = [];
    const results = await runMatrix([cell("haiku-4.5"), cell("nova-pro")], 1, {
      log: () => undefined,
      run: (c, mode, budget) => {
        calls.push([c.name, mode, budget]);
        return Promise.resolve(runOf(mode, 0.2, mode === "scenario" ? 0.05 : 0));
      },
    });
    expect(calls.map(([n, m]) => `${n}/${m}`)).toEqual([
      "haiku-4.5/l1",
      "haiku-4.5/scenario",
      "nova-pro/l1",
      "nova-pro/scenario",
    ]);
    // Each run's guard gets what is left of the matrix budget: the judge counts too.
    expect(calls.map(([, , b]) => Number(b.toFixed(4)))).toEqual([1, 0.8, 0.55, 0.35]);
    expect(results[0]).toMatchObject({ cell: "haiku-4.5", costUsd: 0.45, p95Ms: 900, wallClockMs: 120_000 });
    const [first] = results;
    expect(first !== undefined && !("notRun" in first) ? first.exit.notExitRun : undefined).toEqual([]);
    expect(first !== undefined && !("notRun" in first) ? rowValue(first.exit, "Agent cost") : "").toBe(
      "$0.0133",
    );
  });

  it("an L1 run that spends the whole budget gives the scenario run a budget of 0", async () => {
    const budgets: number[] = [];
    await runMatrix([cell("haiku-4.5")], 0.2, {
      log: () => undefined,
      run: (_c, mode, budget) => {
        budgets.push(budget);
        return Promise.resolve(runOf(mode, 0.3));
      },
    });
    expect(budgets).toEqual([0.2, 0]);
  });

  it("a budget spent exactly leaves no run for the next cell", async () => {
    const calls: string[] = [];
    const results = await runMatrix([cell("haiku-4.5"), cell("nova-pro")], 0.4, {
      log: () => undefined,
      run: (c, mode) => {
        calls.push(`${c.name} ${mode}`);
        return Promise.resolve(runOf(mode, 0.2));
      },
    });
    expect(calls).toEqual(["haiku-4.5 l1", "haiku-4.5 scenario"]);
    expect(results.map((r) => ("notRun" in r ? r.notRun : "ran"))).toEqual([
      "ran",
      "the matrix budget ($0.4) ran out",
    ]);
  });

  it("once the budget is spent, the remaining cells don't run", async () => {
    const results = await runMatrix([cell("haiku-4.5"), cell("nova-pro")], 0.3, {
      log: () => undefined,
      run: (_c, mode) => Promise.resolve(runOf(mode, 0.2)),
    });
    expect(results.map((r) => ("notRun" in r ? r.notRun : undefined))).toEqual([
      undefined,
      "the matrix budget ($0.3) ran out",
    ]);
    const md = matrixMarkdown(results, { suite: "full", trials: 3 });
    expect(md).toContain("# Model matrix: full suite, 3 trial(s) per case");
    expect(md).toContain(
      "| haiku-4.5 | 100% | 100% | 0 (l1 0, scenario 0) | l1 1/1, scenario 1/1 | n/a | $0.0133 | 900 ms | 2.0 min | no | $0.40 |",
    );
    expect(md).toContain("| nova-pro | not run: the matrix budget ($0.3) ran out |");
  });
});

describe("cellRunOptions", () => {
  const llm = new ScriptedLlmClient();
  const args = { suite: "full" as const, trials: 3 };
  const rateLimit = { stats: { calls: 0, retries: 0, throttles: 0 } };
  const onTrial = () => undefined;

  it("is the CLI's runOptions on the cell's profile; scenario mode adds the simulator and the judge", () => {
    const c = cell("gpt-oss-20b@high");
    const l1 = cellRunOptions(c, "l1", args, 5, { llm, rateLimit, onTrial });
    expect(l1).toMatchObject({
      mode: "l1",
      suite: "full",
      trials: 3,
      maxCostUsd: 5,
      profile: c.profile,
      llm,
      llmName: "converse",
      rateLimit,
      onTrial,
    });
    expect(l1.simulator).toBeUndefined();
    expect(l1.judge).toBeUndefined();
    const sc = cellRunOptions(c, "scenario", args, 5, { llm, rateLimit, onTrial });
    expect(sc.simulator?.name).toBe("llm:sonnet-4.6:sim.v1");
    expect(sc.judge?.profile.name).toBe("haiku-4.5");
  });

  it("a cell's report and its results files carry the cell's name", () => {
    expect(asCellReport(runOf("l1", 0.1), cell("gpt-oss-20b@high")).profile).toBe("gpt-oss-20b@high");
  });
});

describe("matrixCommand (r1/A-8)", () => {
  const two = [cell("haiku-4.5"), cell("nova-pro")];
  const base = { cells: two, suite: "full" as const, trials: 3, yes: false, dryRun: false };
  const setup = (answer: string | Error, isTTY = true) => {
    const events: string[] = [];
    const deps: MatrixCommandDeps = {
      log: (line) => events.push(`log ${line}`),
      isTTY,
      ask: (q) => {
        events.push(`ask ${q}`);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      estimate: (c) => (c.name === "haiku-4.5" ? 1.234 : 2.001),
      run: (c, mode, budget) => {
        events.push(`run ${c.name} ${mode} ${budget.toFixed(2)}`);
        return Promise.resolve(runOf(mode, 0.2));
      },
    };
    return { events, deps };
  };

  it("logs each cell's estimate and the total, asks, and runs only after a yes, within 1.5x the total", async () => {
    const { events, deps } = setup("y");
    const results = await matrixCommand(base, deps);
    expect(events.slice(0, 5)).toEqual([
      "log evals:matrix: 2 cell(s), full suite, 3 trial(s) per case, both modes:",
      "log   haiku-4.5            ≈ $1.23",
      "log   nova-pro             ≈ $2.00",
      "log Estimated total ≈ $3.23, simulator and judge included (matrix budget $4.86).",
      "ask Run the matrix at an estimated $3.23? [y/N] ",
    ]);
    // 3.235 * 1.5 = 4.8525, rounded up to the cent.
    expect(events[6]).toBe("run haiku-4.5 l1 4.86");
    expect(defaultMatrixCapUsd(3.235)).toBe(4.86);
    expect(results).toHaveLength(2);
  });

  it("an explicit --max-cost is the budget", async () => {
    const { events, deps } = setup("y");
    await matrixCommand({ ...base, maxCostUsd: 2 }, deps);
    expect(events).toContain(
      "log Estimated total ≈ $3.23, simulator and judge included (matrix budget $2.00).",
    );
    expect(events).toContain("run haiku-4.5 l1 2.00");
  });

  it("--dry-run stops after the estimate: no question, no run", async () => {
    const { events, deps } = setup("y");
    expect(await matrixCommand({ ...base, dryRun: true }, deps)).toBeUndefined();
    expect(events.filter((e) => !e.startsWith("log "))).toEqual([]);
  });

  it("a no runs nothing", async () => {
    const { events, deps } = setup("n");
    expect(await matrixCommand(base, deps)).toBeUndefined();
    expect(events.some((e) => e.startsWith("run "))).toBe(false);
    expect(events.at(-1)).toBe("log evals:matrix: not run.");
  });

  it("off a terminal without --yes it throws before any run; --yes runs without asking", async () => {
    const off = setup("y", false);
    await expect(matrixCommand(base, off.deps)).rejects.toThrow(CliArgError);
    expect(off.events.some((e) => e.startsWith("run ") || e.startsWith("ask "))).toBe(false);
    const yes = setup("n", false);
    await matrixCommand({ ...base, yes: true }, yes.deps);
    expect(yes.events.some((e) => e.startsWith("ask "))).toBe(false);
    expect(yes.events.filter((e) => e.startsWith("run "))).toHaveLength(4);
  });

  it("no run starts before the answer arrives", async () => {
    const events: string[] = [];
    let answer: (a: string) => void = () => undefined;
    const pending = matrixCommand(base, {
      ...setup("y").deps,
      ask: () => new Promise<string>((resolve) => (answer = resolve)),
      run: (c, mode) => {
        events.push(`run ${c.name} ${mode}`);
        return Promise.resolve(runOf(mode, 0.2));
      },
    });
    await Promise.resolve();
    expect(events).toEqual([]);
    answer("y");
    await pending;
    expect(events).toHaveLength(4);
  });
});

describe("matrixMarkdown's verdict column", () => {
  const judged = (r: RunReport): RunReport => ({
    ...r,
    summary: {
      ...r.summary,
      judge: { ...(r.summary.judge ?? summarizeJudge([], [])), rubricAverage: 4.5 },
    },
  });
  const figures = { costUsd: 1, p95Ms: 900, wallClockMs: 60_000 };

  it("says yes for an exit run that meets §7, and not an exit run for a smoke pair", () => {
    const met = exitReport([runOf("l1", 0.2), judged(runOf("scenario", 0.2))]);
    const smoke = exitReport([
      { ...runOf("l1", 0.2), suite: "smoke" },
      judged({ ...runOf("scenario", 0.2), suite: "smoke" }),
    ]);
    const md = matrixMarkdown(
      [
        { cell: "a", exit: met, ...figures },
        { cell: "b", exit: smoke, ...figures },
      ],
      { suite: "full", trials: 3 },
    );
    expect(md).toMatch(/^\| a \| .* \| 4\.50 \/ 5 \| .* \| yes \| \$1\.00 \|$/m);
    expect(md).toMatch(/^\| b \| .* \| not an exit run \| \$1\.00 \|$/m);
  });

  it("rowValue is n/a for a metric the table doesn't have", () => {
    expect(rowValue(exitReport([runOf("l1", 0.1), runOf("scenario", 0.1)]), "No such metric")).toBe("n/a");
  });
});
