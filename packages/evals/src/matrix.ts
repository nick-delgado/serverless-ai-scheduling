/**
 * `npm run evals:matrix` (#34, FR-042): the model comparison. Each cell is an entitled profile, at each
 * effort level where the profile has a reasoning switch (r1/Q-6 (a)): Sonnet 4.6's `output_config.effort`,
 * Nova 2 Lite's `reasoningConfig.maxReasoningEffort` and gpt-oss's `reasoning_effort`, at `low`, `medium` and
 * `high`. A cell is `<profile>@<effort>`; the profile's own default level is the plain profile, run once.
 * `haiku-4.5` and `nova-pro` have no switch and run once. The effort goes into a copy of the profile's
 * `modelFields`; `@sched/agent` is unchanged.
 *
 * Each cell runs PRD §7's two exit runs (`--suite full --trials 3`, both modes, simulator `sonnet-4.6`, judge
 * `haiku-4.5`), writes their results like `npm run evals`, then builds the exit table from them (the
 * `--exit-report` step). Cells run one after another: cells of one model share its rate-limit bucket. The
 * comparison table shows the §7 metrics, agent cost per completed conversation, p95 latency and wall-clock.
 *
 * Before any model call it prints each cell's estimate and the total, then asks y/N on a TTY. `--yes`
 * skips the question; off a TTY without `--yes` it exits 2 (r1/A-8). `--dry-run` stops after the estimate.
 * `--max-cost <usd>` caps the whole matrix (default: 1.5x the estimate); each run's budget guard gets what
 * is left. Other flags: `--cells <name>[,<name>…]`, `--suite`, `--trials`, `--out <dir>`.
 *
 * #34 builds and dry-runs it; the live matrix is #37's.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ConverseLlmClient,
  MODEL_PROFILE_NAMES,
  MODEL_PROFILES,
  type LlmClient,
  type ModelProfile,
  type ModelProfileName,
} from "@sched/agent";

import {
  CliArgError,
  estimateRunCost,
  fileStamp,
  judgeSetup,
  nodeFileWrites,
  orUsageError,
  orUsageErrorAsync,
  parseMaxCost,
  parseSuite,
  parseTrials,
  runOptions,
  selectCases,
  simulatorSetup,
  splitList,
  writeExitReport,
  type JudgeSetup,
  type RunWiring,
  type SimulatorSetup,
} from "./cli-args";
import { loadScenarios, type LoadedScenarios, type Suite } from "./loader";
import { rateLimited } from "./rate-limit";
import { exitMet, exitReport, type ExitReport } from "./report/exit";
import { prepareResultsCopyDir, resultsCopyDir, resultsWrittenLine, writeRunResults } from "./results-copy";
import { markdownSummary, runSuite } from "./suite";
import type { L1Case, Scenario } from "./schema";
import type { Mode, RunReport, RunSuiteOptions } from "./suite";
import { errorReason } from "./util";

export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

type Fields = Readonly<Record<string, unknown>>;
const objectAt = (fields: Fields, key: string): Fields => {
  const value = fields[key];
  return typeof value === "object" && value !== null ? (value as Fields) : {};
};

/** A profile's reasoning switch: its default level, and how a level is written into `modelFields`. */
export interface EffortSwitch {
  readonly default: Effort;
  readonly apply: (fields: Fields, effort: Effort) => Fields;
}

const gptOss: EffortSwitch = {
  default: "low",
  apply: (fields, effort) => ({ ...fields, reasoning_effort: effort }),
};

/** The profiles with a reasoning switch (r1/Q-6 (a)); any other profile runs once. */
export const EFFORT_SWITCHES: Partial<Record<ModelProfileName, EffortSwitch>> = {
  "sonnet-4.6": {
    default: "medium",
    apply: (fields, effort) => ({
      ...fields,
      output_config: { ...objectAt(fields, "output_config"), effort },
    }),
  },
  "nova-2-lite": {
    default: "low",
    apply: (fields, effort) => ({
      ...fields,
      reasoningConfig: { ...objectAt(fields, "reasoningConfig"), maxReasoningEffort: effort },
    }),
  },
  "gpt-oss-120b": gptOss,
  "gpt-oss-20b": gptOss,
};

export interface MatrixCell {
  /** `<profile>` or `<profile>@<effort>`; results and reports carry it. */
  name: string;
  profile: ModelProfile;
}

/** Every cell of the matrix: each entitled profile, and its non-default effort levels. */
export function matrixCells(): MatrixCell[] {
  return MODEL_PROFILE_NAMES.filter((n) => MODEL_PROFILES[n].entitled).flatMap((name) => {
    const profile = MODEL_PROFILES[name];
    const sw = EFFORT_SWITCHES[name];
    if (sw === undefined) return [{ name, profile }];
    return EFFORT_LEVELS.map((effort) =>
      effort === sw.default
        ? { name, profile }
        : {
            name: `${name}@${effort}`,
            profile: { ...profile, modelFields: sw.apply(profile.modelFields, effort) },
          },
    );
  });
}

export interface MatrixArgs {
  cells: MatrixCell[];
  suite: Suite;
  trials: number;
  /** The cap for the whole matrix; undefined: 1.5x the estimate. */
  maxCostUsd?: number;
  yes: boolean;
  dryRun: boolean;
  out: string;
}

/** Parse `npm run evals:matrix` arguments. Throws `CliArgError`. */
export function parseMatrixArgs(argv: readonly string[], defaultOut: string): MatrixArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        cells: { type: "string" },
        suite: { type: "string", default: "full" },
        trials: { type: "string", default: "3" },
        "max-cost": { type: "string" },
        yes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        out: { type: "string", default: defaultOut },
      },
      strict: true,
    }));
  } catch (error) {
    throw new CliArgError(errorReason(error));
  }
  const all = matrixCells();
  const wanted = values.cells === undefined ? undefined : splitList(values.cells);
  const unknown = (wanted ?? []).filter((w) => !all.some((c) => c.name === w));
  if (unknown.length > 0)
    throw new CliArgError(
      `--cells: unknown cell ${unknown.join(", ")}; cells: ${all.map((c) => c.name).join(", ")}`,
    );
  const maxCost = values["max-cost"];
  return {
    cells: wanted === undefined ? all : all.filter((c) => wanted.includes(c.name)),
    suite: parseSuite(values.suite),
    trials: parseTrials(values.trials),
    ...(maxCost === undefined ? {} : { maxCostUsd: parseMaxCost(maxCost) }),
    yes: values.yes,
    dryRun: values["dry-run"],
    out: values.out,
  };
}

/** The patient and the judge of a cell's run in one mode. */
export interface MatrixSetup {
  simulator: SimulatorSetup;
  judging: JudgeSetup;
}

/**
 * A run's patient and judge in `mode`, decided by the CLI's own `simulatorSetup` and `judgeSetup` at their
 * defaults: in scenario mode the LLM simulator on `sonnet-4.6` (PRD §7) and the judge on `haiku-4.5`; in L1
 * mode neither.
 */
export const matrixSetup = (llm: LlmClient, mode: Mode): MatrixSetup => ({
  /* v8 ignore next -- a matrix run never replays, so simulatorSetup never calls readReplay */
  simulator: simulatorSetup({ mode }, { llm, readReplay: () => undefined }),
  judging: judgeSetup({ mode, judge: true }, { llm }),
});

/** The cases a cell runs in a mode: the CLI's selection, the whole suite. */
export const matrixCases = (loaded: LoadedScenarios, mode: Mode, suite: Suite): (Scenario | L1Case)[] =>
  selectCases(loaded, { mode, suite, filters: [], ids: [] });

/** A cell's estimate: both runs, the simulator and the judge included. */
export function cellEstimateUsd(
  cell: MatrixCell,
  loaded: LoadedScenarios,
  args: Pick<MatrixArgs, "suite" | "trials">,
  llm: LlmClient,
): number {
  return (["l1", "scenario"] as const).reduce((sum, mode) => {
    const setup = matrixSetup(llm, mode);
    const cases = matrixCases(loaded, mode, args.suite);
    return sum + estimateRunCost(cases, cell.profile, args.trials, setup.simulator, setup.judging);
  }, 0);
}

/**
 * Whether to go ahead after the estimate: `--yes` does; a TTY asks y/N; off a TTY without `--yes` it's a
 * usage error (exit 2), before any model call (r1/A-8).
 */
export async function confirmMatrix(
  args: Pick<MatrixArgs, "yes">,
  io: { isTTY: boolean; ask: (question: string) => Promise<string> },
  totalUsd: number,
): Promise<boolean> {
  if (args.yes) return true;
  if (!io.isTTY) throw new CliArgError("not a terminal: pass --yes to run the matrix without the question");
  const answer = await io.ask(`Run the matrix at an estimated $${totalUsd.toFixed(2)}? [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** One cell's outcome: its exit table and run figures, or why it didn't run (the matrix budget ran out). */
export type CellResult =
  | { cell: string; notRun: string }
  | {
      cell: string;
      exit: ExitReport;
      /** Agent, simulator and judge, both runs. */
      costUsd: number;
      /** The scenario run's p95 turn latency, ms. */
      p95Ms: number;
      wallClockMs: number;
    };

/** What `runMatrix` needs from outside: one run of a cell in a mode, with a budget, and a log. */
export interface MatrixDeps {
  run: (cell: MatrixCell, mode: Mode, maxCostUsd: number) => Promise<RunReport>;
  log: (line: string) => void;
}

/** Everything a run cost, the judge included (it's outside `costUsd`). */
export const runSpendUsd = (r: RunReport): number => r.summary.costUsd + (r.summary.judge?.costUsd ?? 0);

/**
 * Run the cells one after another, both modes each, and build each cell's exit table. The matrix budget is
 * shared: each run's guard gets what is left, and once nothing is left the remaining cells don't run.
 */
export async function runMatrix(
  cells: readonly MatrixCell[],
  maxCostUsd: number,
  deps: MatrixDeps,
): Promise<CellResult[]> {
  const results: CellResult[] = [];
  let spent = 0;
  for (const cell of cells) {
    const left = maxCostUsd - spent;
    if (left <= 0) {
      results.push({
        cell: cell.name,
        notRun: `the matrix budget ($${maxCostUsd}) ran out`,
      });
      continue;
    }
    deps.log(`matrix: ${cell.name} (${cell.profile.modelId})`);
    const l1 = await deps.run(cell, "l1", left);
    spent += runSpendUsd(l1);
    // What is left, never below 0: a spent budget starts no scenario trial (the guard stops at spend >= cap).
    const scenario = await deps.run(cell, "scenario", Math.max(maxCostUsd - spent, 0));
    spent += runSpendUsd(scenario);
    results.push({
      cell: cell.name,
      exit: exitReport([l1, scenario]),
      costUsd: runSpendUsd(l1) + runSpendUsd(scenario),
      p95Ms: scenario.summary.latencyMs.p95,
      wallClockMs: l1.wallClockMs + scenario.wallClockMs,
    });
  }
  return results;
}

/** The value of the exit table's headline row whose metric starts with `prefix`; n/a when there's none. */
export const rowValue = (exit: ExitReport, prefix: string): string =>
  exit.rows.find((r) => r.sub !== true && r.metric.startsWith(prefix))?.value ?? "n/a";

/** The comparison table (r1/A-8): one row per cell. */
export function matrixMarkdown(
  results: readonly CellResult[],
  args: Pick<MatrixArgs, "suite" | "trials">,
): string {
  const lines = [
    `# Model matrix: ${args.suite} suite, ${args.trials} trial(s) per case`,
    "",
    "Agent cost is the agent's share (not the simulator's or the judge's). A cell meets §7 only in an exit run with every headline target met; agreement and NFR-001 are measured elsewhere.",
    "",
    "| Cell | Task success | Reliability | Safety violations | Emergency | Rubric avg | Agent $ / completed | p95 latency | Wall-clock | Meets §7 | Run cost |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    if ("notRun" in r) {
      lines.push(`| ${r.cell} | not run: ${r.notRun} | | | | | | | | | |`);
      continue;
    }
    const e = r.exit;
    const meets = exitMet(e) ? "yes" : e.notExitRun.length > 0 ? "not an exit run" : "no";
    lines.push(
      `| ${r.cell} | ${rowValue(e, "Task success")} | ${rowValue(e, "Reliability")} | ${rowValue(e, "Safety")} | ${rowValue(e, "Emergency")} | ${rowValue(e, "Judge rubric")} | ${rowValue(e, "Agent cost")} | ${r.p95Ms} ms | ${(r.wallClockMs / 60000).toFixed(1)} min | ${meets} | $${r.costUsd.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

/**
 * The `runSuite` options of one cell's run: the CLI's `runOptions` on the cell's profile, with the mode's
 * patient and judge from `matrixSetup`.
 */
export function cellRunOptions(
  cell: MatrixCell,
  mode: Mode,
  args: Pick<MatrixArgs, "suite" | "trials">,
  maxCostUsd: number,
  wiring: Pick<RunWiring, "llm" | "rateLimit" | "onTrial">,
): RunSuiteOptions {
  const { simulator, judging } = matrixSetup(wiring.llm, mode);
  return runOptions(
    { mode, suite: args.suite, trials: args.trials, profile: cell.profile, maxCostUsd },
    { ...wiring, setup: simulator, judging },
  );
}

/** The matrix's default budget: 1.5x the estimate, rounded up to the cent. */
export const defaultMatrixCapUsd = (estimateUsd: number): number => Math.ceil(estimateUsd * 1.5 * 100) / 100;

/** What `matrixCommand` needs from outside: the log, the terminal, each cell's estimate, and one run. */
export interface MatrixCommandDeps extends MatrixDeps {
  isTTY: boolean;
  ask: (question: string) => Promise<string>;
  estimate: (cell: MatrixCell) => number;
}

/**
 * The command before and around the runs (r1/A-8): log each cell's estimate and the total with the budget
 * (`--max-cost`, else `defaultMatrixCapUsd`), stop there on `--dry-run`, then ask (`confirmMatrix`), and only
 * after a yes run the cells. Returns the results, or `undefined` when nothing ran.
 */
export async function matrixCommand(
  args: Pick<MatrixArgs, "cells" | "suite" | "trials" | "maxCostUsd" | "yes" | "dryRun">,
  deps: MatrixCommandDeps,
): Promise<CellResult[] | undefined> {
  deps.log(
    `evals:matrix: ${args.cells.length} cell(s), ${args.suite} suite, ${args.trials} trial(s) per case, both modes:`,
  );
  let total = 0;
  for (const cell of args.cells) {
    const estimate = deps.estimate(cell);
    total += estimate;
    deps.log(`  ${cell.name.padEnd(20)} ≈ $${estimate.toFixed(2)}`);
  }
  const cap = args.maxCostUsd ?? defaultMatrixCapUsd(total);
  deps.log(
    `Estimated total ≈ $${total.toFixed(2)}, simulator and judge included (matrix budget $${cap.toFixed(2)}).`,
  );
  if (args.dryRun) return undefined;
  if (!(await confirmMatrix(args, deps, total))) {
    deps.log("evals:matrix: not run.");
    return undefined;
  }
  return runMatrix(args.cells, cap, deps);
}

/** A cell's report carries the cell's name as its profile, so its results files and tables name the cell. */
export const asCellReport = (report: RunReport, cell: MatrixCell): RunReport => ({
  ...report,
  profile: cell.name,
});

/* v8 ignore start -- the process entry point: it runs only as a script under tsx, never in tests. Its parts are tested functions (the arguments, matrixCommand's estimate, budget, dry-run stop, confirmation and run loop, the run options, the exit writer, the table); what stays here is wiring: the client, the terminal, the files and the progress lines. */
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
const CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function fail(message: string): never {
  console.error(`evals:matrix: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = orUsageError(() => parseMatrixArgs(process.argv.slice(2), RESULTS_DIR), fail);
  const loaded = loadScenarios();
  const llm = rateLimited(new ConverseLlmClient({ maxAttempts: 1 }), {
    onRetry: ({ modelId, attempt, delayMs, error }) =>
      console.log(`  retry ${attempt} on ${modelId} in ${delayMs} ms (${errorReason(error)})`),
  });
  const copyDir = orUsageError(
    () => resultsCopyDir({ env: process.env, home: homedir(), checkout: CHECKOUT }),
    fail,
  );
  const ask = async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
  const results = await orUsageErrorAsync(
    () =>
      matrixCommand(args, {
        log: console.log,
        isTTY: process.stdin.isTTY,
        ask,
        estimate: (cell) => cellEstimateUsd(cell, loaded, args, llm),
        run: async (cell, mode, budget) => {
          prepareResultsCopyDir(copyDir, args);
          const onTrial: RunWiring["onTrial"] = (id, t) =>
            console.log(`  ${t.status.padEnd(5)} ${mode} ${id}#${t.trial}  $${t.costUsd.toFixed(5)}`);
          const options = cellRunOptions(cell, mode, args, budget, { llm, rateLimit: llm, onTrial });
          const report = asCellReport(await runSuite(matrixCases(loaded, mode, args.suite), options), cell);
          const written = writeRunResults(report, markdownSummary(report), { out: args.out, copyDir });
          console.log(resultsWrittenLine(written, console.error));
          return report;
        },
      }),
    fail,
  );
  if (results === undefined) return;
  const stamp = fileStamp(new Date().toISOString());
  mkdirSync(args.out, { recursive: true });
  for (const r of results) if (!("notRun" in r)) writeExitReport(r.exit, args.out, nodeFileWrites.writeFile);
  const md = matrixMarkdown(results, args);
  writeFileSync(join(args.out, `${stamp}-matrix.json`), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(args.out, `${stamp}-matrix.md`), `${md}\n`);
  console.log(`\n${md}\n\nevals:matrix: wrote ${join(args.out, `${stamp}-matrix.md`)}`);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
/* v8 ignore stop -- end of the entry point */
