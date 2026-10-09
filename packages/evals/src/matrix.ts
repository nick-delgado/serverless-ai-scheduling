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
  orUsageError,
  orUsageErrorAsync,
  simulatorSetup,
  type JudgeSetup,
  type SimulatorSetup,
} from "./cli-args";
import { loadScenarios, selectSuite, SUITES, type LoadedScenarios, type Suite } from "./loader";
import { rateLimited } from "./rate-limit";
import { exitMarkdown, exitMet, exitReport, type ExitReport } from "./report/exit";
import { prepareResultsCopyDir, resultsCopyDir, resultsWrittenLine, writeRunResults } from "./results-copy";
import { markdownSummary, runSuite } from "./suite";
import { conversationMetrics } from "./report/metrics";
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
  const wanted = values.cells
    ?.split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const unknown = (wanted ?? []).filter((w) => !all.some((c) => c.name === w));
  if (unknown.length > 0)
    throw new CliArgError(
      `--cells: unknown cell ${unknown.join(", ")}; cells: ${all.map((c) => c.name).join(", ")}`,
    );
  const { suite } = values;
  if (!(SUITES as readonly string[]).includes(suite))
    throw new CliArgError(`--suite must be ${SUITES.join(" or ")}, got ${suite}`);
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1) throw new CliArgError("--trials must be a positive integer");
  const maxCost = values["max-cost"] === undefined ? undefined : Number(values["max-cost"]);
  if (maxCost !== undefined && !(maxCost > 0))
    throw new CliArgError("--max-cost must be a positive number of USD");
  return {
    cells: wanted === undefined ? all : all.filter((c) => wanted.includes(c.name)),
    suite: suite as Suite,
    trials,
    ...(maxCost === undefined ? {} : { maxCostUsd: maxCost }),
    yes: values.yes,
    dryRun: values["dry-run"],
    out: values.out,
  };
}

/** The patient and judge every cell shares: the simulator on `sonnet-4.6`, the judge on `haiku-4.5`. */
export interface MatrixSetup {
  simulator: SimulatorSetup;
  judging: JudgeSetup;
}

/** The matrix's simulator and judge on `llm`, at their defaults (PRD §7: simulator `sonnet-4.6`). */
export const matrixSetup = (llm: LlmClient): MatrixSetup => ({
  simulator: simulatorSetup({ mode: "scenario" }, { llm, readReplay: () => undefined }),
  judging: judgeSetup({ mode: "scenario", judge: true }, { llm }),
});

/** The cases a cell runs in a mode. */
export const matrixCases = (loaded: LoadedScenarios, mode: Mode, suite: Suite): (Scenario | L1Case)[] =>
  selectSuite<Scenario | L1Case>(mode === "l1" ? loaded.l1 : loaded.scenarios, suite);

/** A cell's estimate: both runs, the simulator and the judge included. */
export function cellEstimateUsd(
  cell: MatrixCell,
  loaded: LoadedScenarios,
  args: Pick<MatrixArgs, "suite" | "trials">,
  setup: MatrixSetup,
): number {
  return (
    estimateRunCost(matrixCases(loaded, "l1", args.suite), cell.profile, args.trials) +
    estimateRunCost(
      matrixCases(loaded, "scenario", args.suite),
      cell.profile,
      args.trials,
      setup.simulator,
      setup.judging,
    )
  );
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

/** One cell's outcome. */
export interface CellResult {
  cell: string;
  /** Why the cell didn't run (the matrix budget ran out), when it didn't. */
  notRun?: string;
  exit?: ExitReport;
  /** Agent, simulator and judge, both runs. */
  costUsd: number;
  agentCostPerCompletedUsd?: number;
  /** The scenario run's p95 turn latency, ms. */
  p95Ms?: number;
  wallClockMs: number;
}

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
        costUsd: 0,
        wallClockMs: 0,
      });
      continue;
    }
    deps.log(`matrix: ${cell.name} (${cell.profile.modelId})`);
    const l1 = await deps.run(cell, "l1", left);
    spent += runSpendUsd(l1);
    const scenario = await deps.run(cell, "scenario", Math.max(maxCostUsd - spent, Number.EPSILON));
    spent += runSpendUsd(scenario);
    const perCompleted = conversationMetrics(
      scenario.cases.flatMap((c) => c.trials),
    ).agentCostPerCompletedUsd;
    results.push({
      cell: cell.name,
      exit: exitReport([l1, scenario]),
      costUsd: runSpendUsd(l1) + runSpendUsd(scenario),
      ...(perCompleted === undefined ? {} : { agentCostPerCompletedUsd: perCompleted }),
      p95Ms: scenario.summary.latencyMs.p95,
      wallClockMs: l1.wallClockMs + scenario.wallClockMs,
    });
  }
  return results;
}

const rowValue = (exit: ExitReport, prefix: string): string =>
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
    if (r.exit === undefined) {
      lines.push(`| ${r.cell} | not run: ${r.notRun ?? ""} | | | | | | | | | |`);
      continue;
    }
    const e = r.exit;
    lines.push(
      `| ${r.cell} | ${rowValue(e, "Task success")} | ${rowValue(e, "Reliability")} | ${rowValue(e, "Safety")} | ${rowValue(e, "Emergency")} | ${rowValue(e, "Judge rubric")} | ${r.agentCostPerCompletedUsd === undefined ? "n/a" : `$${r.agentCostPerCompletedUsd.toFixed(4)}`} | ${r.p95Ms ?? 0} ms | ${(r.wallClockMs / 60000).toFixed(1)} min | ${exitMet(e) ? "yes" : e.notExitRun.length > 0 ? "not an exit run" : "no"} | $${r.costUsd.toFixed(2)} |`,
    );
  }
  return lines.join("\n");
}

/** The `runSuite` options of one cell's run: the cell's profile, the shared simulator and judge. */
export function cellRunOptions(
  cell: MatrixCell,
  mode: Mode,
  args: Pick<MatrixArgs, "suite" | "trials">,
  maxCostUsd: number,
  wiring: { llm: LlmClient; setup: MatrixSetup; rateLimit: RunSuiteOptions["rateLimit"] },
): RunSuiteOptions {
  const { simulator } = wiring.setup.simulator;
  const { judging } = wiring.setup;
  return {
    mode,
    suite: args.suite,
    llm: wiring.llm,
    llmName: "converse",
    profile: cell.profile,
    trials: args.trials,
    maxCostUsd,
    ...(wiring.rateLimit === undefined ? {} : { rateLimit: wiring.rateLimit }),
    ...(mode === "scenario" && simulator !== undefined ? { simulator } : {}),
    ...(mode === "scenario" && judging.kind === "llm"
      ? { judge: { judge: judging.judge, profile: judging.profile } }
      : {}),
  };
}

/** A cell's report carries the cell's name as its profile, so its results files and tables name the cell. */
export const asCellReport = (report: RunReport, cell: MatrixCell): RunReport => ({
  ...report,
  profile: cell.name,
});

/* v8 ignore start -- the process entry point: it runs only as a script under tsx, never in tests. Its parts are this file's tested functions (arguments, cells, estimates, the confirmation, the run loop, the run options, the table); what stays here is wiring: the client, the console, the files and the progress lines. */
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
  const setup = matrixSetup(llm);
  let total = 0;
  console.log(
    `evals:matrix: ${args.cells.length} cell(s), ${args.suite} suite, ${args.trials} trial(s) per case, both modes:`,
  );
  for (const cell of args.cells) {
    const estimate = cellEstimateUsd(cell, loaded, args, setup);
    total += estimate;
    console.log(`  ${cell.name.padEnd(20)} ≈ $${estimate.toFixed(2)}`);
  }
  const cap = args.maxCostUsd ?? Math.ceil(total * 1.5 * 100) / 100;
  console.log(
    `Estimated total ≈ $${total.toFixed(2)}, simulator and judge included (matrix budget $${cap.toFixed(2)}).`,
  );
  const copyDir = orUsageError(
    () => resultsCopyDir({ env: process.env, home: homedir(), checkout: CHECKOUT }),
    fail,
  );
  if (args.dryRun) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const go = await orUsageErrorAsync(
    () => confirmMatrix(args, { isTTY: process.stdin.isTTY, ask: (q) => rl.question(q) }, total),
    fail,
  ).finally(() => rl.close());
  if (!go) {
    console.log("evals:matrix: not run.");
    return;
  }
  orUsageError(() => prepareResultsCopyDir(copyDir, args), fail);
  const results = await runMatrix(args.cells, cap, {
    log: console.log,
    run: async (cell, mode, budget) => {
      const cases = matrixCases(loaded, mode, args.suite);
      const report = asCellReport(
        await runSuite(cases, {
          ...cellRunOptions(cell, mode, args, budget, { llm, setup, rateLimit: llm }),
          onTrial: (id, t) =>
            console.log(`  ${t.status.padEnd(5)} ${mode} ${id}#${t.trial}  $${t.costUsd.toFixed(5)}`),
        }),
        cell,
      );
      console.log(
        resultsWrittenLine(
          writeRunResults(report, markdownSummary(report), { out: args.out, copyDir }),
          console.error,
        ),
      );
      return report;
    },
  });
  const stamp = fileStamp(new Date().toISOString());
  mkdirSync(args.out, { recursive: true });
  for (const r of results)
    if (r.exit !== undefined)
      writeFileSync(join(args.out, `${stamp}-exit-${r.cell}.md`), `${exitMarkdown(r.exit)}\n`);
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
