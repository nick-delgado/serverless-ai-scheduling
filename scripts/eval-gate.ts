/**
 * The CI eval gate's decisions (#34, FR-041, ADR-008 amendment 2026-10-09). `.github/workflows/evals.yml` runs
 * the commands; every decision is here, with its tests (r1/A-6).
 *
 *   tsx scripts/eval-gate.ts plan [--base <ref>]
 *   tsx scripts/eval-gate.ts errored <results-dir>
 *   tsx scripts/eval-gate.ts verdict --results <dir> --baseline <file>
 *
 * `plan` decides whether the gate calls Bedrock (r1/Q-3 (b)): only when the PR changes a gated path
 * (`GATED_PREFIXES`, `GATED_FILES`, and every non-test file under `packages/contracts/src/`). The diff is
 * `git diff --name-only --no-renames <base>...HEAD`, so a renamed file counts under both names. The base is
 * `--base`, else `PR_BASE` (the workflow passes the PR's base SHA), else `origin/main`. When a gated path
 * changed but the run has no credentials (an empty `AWS_EVAL_ROLE_ARN`: GitHub passes no secrets to a fork's
 * or Dependabot's run), it fails closed, naming why (r1/Q-2 (a)). It writes `run=true|false` to `GITHUB_OUTPUT`.
 *
 * `errored` prints the comma-separated IDs of the errored cases in the one results JSON in `<results-dir>`
 * (none: an empty line), for the workflow's single re-run of them with `--ids` (r1/A-4).
 *
 * `verdict` reads `<dir>/l1`, `<dir>/scenario` and, when they exist, `<dir>/l1-rerun` and
 * `<dir>/scenario-rerun`, compares each mode with the baseline per case (r1/Q-1 (a)), and fails on any safety
 * violation (both attempts counted), more than one regression in a mode, a budget-stopped case (re-run
 * included), or a case still `error` after the re-run. A re-run's status replaces the errored one. It appends
 * the comparison and both runs' markdown summaries to `GITHUB_STEP_SUMMARY`. It never reads the CLI's exit code
 * or the judge's scores.
 *
 * Exit codes: 0 pass (or nothing to evaluate); 1 the gate fails; 2 the gate couldn't decide (bad arguments, no
 * merge base, a results file missing or malformed).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  compareMode,
  MAX_REGRESSIONS_PER_MODE,
  parseBaseline,
  parseRunReport,
  type Baseline,
  type CaseStatus,
  type Mode,
  type ModeComparison,
  type RunReport,
} from "@sched/evals";

import { baseRef, namesSince, type ScriptDeps, scriptIo } from "./coverage-changed";

/** Changes under these move the agent, its tools, or the gate's own verdicts (r1/Q-3 (b)). */
export const GATED_PREFIXES = [
  "packages/agent/",
  "packages/tools/",
  "packages/evals/src/",
  "packages/evals/scenarios/",
  "packages/evals/baselines/",
] as const;
export const GATED_FILES = [".github/workflows/evals.yml"] as const;
const CONTRACTS_SRC = "packages/contracts/src/";

/** Gated paths the plan's summary names before "and N more". */
const MAX_LISTED = 10;

/** True for a path whose change makes the gate run the evals. */
export function isGatedPath(path: string): boolean {
  if ((GATED_FILES as readonly string[]).includes(path)) return true;
  if (GATED_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  return path.startsWith(CONTRACTS_SRC) && !/\.test\.[cm]?[jt]sx?$/.test(path);
}

export interface PlanInput {
  changed: readonly string[];
  /** `AWS_EVAL_ROLE_ARN` is set (never its value). */
  hasCredentials: boolean;
  /** The PR's head is in another repository. */
  fork: boolean;
  /** The run's actor is Dependabot. */
  dependabot: boolean;
}

export interface Plan {
  run: boolean;
  /** Fail closed: gated paths changed and there are no credentials. */
  failure?: string;
  gated: string[];
  summary: string;
}

/** Whether the gate runs the evals (r1/Q-3 (b)), and whether it fails closed (r1/Q-2 (a)). */
export function planGate(input: PlanInput): Plan {
  const gated = input.changed.filter(isGatedPath);
  if (gated.length === 0)
    return {
      run: false,
      gated,
      summary:
        "No agent, tools, contracts or eval-harness path changed: the gate passes without calling Bedrock.",
    };
  const shown = gated.slice(0, MAX_LISTED).map((p) => `\`${p}\``);
  const list = `${shown.join(", ")}${gated.length > MAX_LISTED ? ` and ${gated.length - MAX_LISTED} more` : ""}`;
  if (!input.hasCredentials) {
    const who = input.fork
      ? "a pull request from a fork"
      : input.dependabot
        ? "a Dependabot pull request"
        : "a run without the AWS_EVAL_ROLE_ARN secret";
    const remedy = input.fork
      ? "Nick pushes the branch to this repository and opens a PR from it"
      : "Nick gives the run credentials (a push of his own to the branch; a re-run keeps the first run's privileges)";
    const failure = `Gated paths changed (${list}), but this is ${who}, so the run has no AWS credentials and can't evaluate them. ${remedy}, or merges with an admin bypass after a local smoke run recorded in the PR (#34 r1/Q-2 (a); docs/runbooks/aws-setup.md, "CI credentials (GitHub OIDC)").`;
    return { run: false, failure, gated, summary: failure };
  }
  return {
    run: true,
    gated,
    summary: `Gated paths changed: ${list}. Running the smoke suite in both modes.`,
  };
}

/** The IDs of a run's errored cases (r1/A-4). */
export const erroredIds = (report: RunReport): string[] =>
  report.cases.filter((c) => c.status === "error").map((c) => c.id);

/** One mode's first run and, when errored cases were re-run, the re-run. */
export interface ModeRuns {
  first: RunReport;
  rerun?: RunReport;
}

/** A mode after its re-run: the re-run's statuses replace the errored ones; safety counts both attempts. */
export interface MergedMode {
  mode: Mode;
  statuses: Record<string, CaseStatus>;
  safetyViolations: number;
  budgetStopped: string[];
  stillErrored: string[];
  rerunIds: string[];
}

export function mergeRerun(mode: Mode, runs: ModeRuns): MergedMode {
  const statuses: Record<string, CaseStatus> = Object.fromEntries(
    runs.first.cases.map((c) => [c.id, c.status]),
  );
  const rerunIds = runs.rerun?.cases.map((c) => c.id) ?? [];
  for (const c of runs.rerun?.cases ?? []) statuses[c.id] = c.status;
  const all = [...runs.first.cases, ...(runs.rerun?.cases ?? [])];
  return {
    mode,
    statuses,
    safetyViolations: runs.first.summary.safetyViolations + (runs.rerun?.summary.safetyViolations ?? 0),
    budgetStopped: [...new Set(all.filter((c) => c.budgetStopped).map((c) => c.id))],
    stillErrored: Object.entries(statuses)
      .filter(([, s]) => s === "error")
      .map(([id]) => id),
    rerunIds,
  };
}

export interface Verdict {
  passed: boolean;
  failures: string[];
  comparisons: ModeComparison[];
  merged: MergedMode[];
}

/** The gate's verdict on both modes (FR-041). */
export function gateVerdict(baseline: Baseline, runs: Record<Mode, ModeRuns>): Verdict {
  const failures: string[] = [];
  const merged: MergedMode[] = [];
  const comparisons: ModeComparison[] = [];
  for (const mode of ["l1", "scenario"] as const) {
    const m = mergeRerun(mode, runs[mode]);
    merged.push(m);
    const cmp = compareMode(mode, baseline.modes[mode], {
      modelId: runs[mode].first.modelId,
      promptVersion: runs[mode].first.promptVersion,
      statuses: m.statuses,
    });
    comparisons.push(cmp);
    if (m.safetyViolations > 0) failures.push(`${mode}: ${m.safetyViolations} safety violation(s)`);
    if (cmp.failed)
      failures.push(
        `${mode}: ${cmp.regressions.length} case(s) below the baseline (at most ${MAX_REGRESSIONS_PER_MODE}): ${cmp.regressions.join(", ")}`,
      );
    if (m.budgetStopped.length > 0)
      failures.push(`${mode}: budget-stopped case(s): ${m.budgetStopped.join(", ")}`);
    if (m.stillErrored.length > 0)
      failures.push(`${mode}: still \`error\` after the re-run: ${m.stillErrored.join(", ")}`);
  }
  return { passed: failures.length === 0, failures, comparisons, merged };
}

const show = (s: CaseStatus | undefined) => s ?? "–";

/** The job summary's verdict section: the result, the failures, and each mode's comparison table. */
export function verdictMarkdown(v: Verdict, baselineFile: string): string {
  const lines = [
    `## Eval gate: ${v.passed ? "passed" : "failed"}`,
    "",
    ...(v.failures.length === 0
      ? ["No safety violation, no budget stop, no case still `error`, and at most one regression per mode."]
      : v.failures.map((f) => `- ${f}`)),
  ];
  for (const cmp of v.comparisons) {
    const m = v.merged.find((x) => x.mode === cmp.mode);
    lines.push(
      "",
      `### ${cmp.mode}: ${cmp.regressions.length} regression(s) against \`${baselineFile}\``,
      ...cmp.warnings.map((w) => `- Warning: ${w}`),
      ...(m !== undefined && m.rerunIds.length > 0
        ? [`- Re-ran the errored case(s) once: ${m.rerunIds.join(", ")}`]
        : []),
      "",
      "| Case | Baseline | Now | |",
      "|---|---|---|---|",
      ...cmp.rows.map(
        (r) =>
          `| ${r.id} | ${show(r.baseline)} | ${show(r.now)} | ${r.regressed ? "**regression**" : (r.note ?? "")} |`,
      ),
    );
  }
  return lines.join("\n");
}

/** A run's markdown summary as a collapsed section of the job summary, its title line as the toggle. */
export function collapsed(md: string): string {
  const [title = "", ...rest] = md.split("\n");
  return `<details><summary>${title.replace(/^#+\s*/, "")}</summary>\n\n${rest.join("\n").trim()}\n\n</details>\n`;
}

/** What the commands read and write; tests pass their own. */
export interface GateDeps extends ScriptDeps {
  /** The `.json` file names in a directory; `undefined` when it doesn't exist. */
  listJson?: (dir: string) => string[] | undefined;
  readText?: (path: string) => string;
  /** Append to a file named by an environment variable (`GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`). */
  append?: (path: string, text: string) => void;
}

const nodeListJson = (dir: string): string[] | undefined =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : undefined;

/** The one results JSON in `dir`, parsed; `undefined` when the directory doesn't exist. */
function readRunDir(
  dir: string,
  deps: Required<Pick<GateDeps, "listJson" | "readText">>,
): RunReport | undefined {
  const files = deps.listJson(dir);
  if (files === undefined) return undefined;
  const [file] = files;
  if (files.length !== 1 || file === undefined)
    throw new Error(`${dir} holds ${files.length} results files, not one`);
  const path = join(dir, file);
  return parseRunReport(JSON.parse(deps.readText(path)), path);
}

/** The run's markdown summary next to its JSON, when there is one. */
function runMarkdown(dir: string, deps: Required<Pick<GateDeps, "listJson" | "readText">>): string {
  const [file] = deps.listJson(dir) ?? [];
  if (file === undefined) return "";
  try {
    return deps.readText(join(dir, file.replace(/\.json$/, ".md")));
  } catch {
    return "";
  }
}

/** The script's entry point; returns the exit code (see the header). `vars` is the process environment. */
export function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: GateDeps = {},
): number {
  const { log, logError, git } = scriptIo(deps);
  const files = {
    listJson: deps.listJson ?? nodeListJson,
    readText: deps.readText ?? ((p: string) => readFileSync(p, "utf8")),
  };
  const append = deps.append ?? appendFileSync;
  const toEnvFile = (name: string, text: string) => {
    const path = vars[name];
    if (path) append(path, text);
  };
  const [command, ...rest] = argv;
  let values: { base?: string; results?: string; baseline?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      options: { base: { type: "string" }, results: { type: "string" }, baseline: { type: "string" } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    logError(`eval-gate: ${(err as Error).message}`);
    return 2;
  }

  if (command === "plan") {
    const base = baseRef(values.base, vars.PR_BASE);
    let changed: string[];
    try {
      // --no-renames: a renamed file is listed as deleted and added, so both names count (r1/Q-3 edges).
      changed = namesSince(git, base, "--no-renames");
    } catch (err) {
      logError(`eval-gate: can't diff against ${base} (fetch the full history): ${(err as Error).message}`);
      return 2;
    }
    const plan = planGate({
      changed,
      hasCredentials: Boolean(vars.AWS_EVAL_ROLE_ARN),
      fork: Boolean(vars.PR_HEAD_REPO) && vars.PR_HEAD_REPO !== vars.GITHUB_REPOSITORY,
      dependabot: vars.GITHUB_ACTOR === "dependabot[bot]",
    });
    log(`eval-gate: ${plan.summary}`);
    toEnvFile("GITHUB_OUTPUT", `run=${String(plan.run)}\n`);
    toEnvFile("GITHUB_STEP_SUMMARY", `## Eval gate\n\n${plan.summary}\n`);
    if (plan.failure !== undefined) {
      logError(`::error::${plan.failure}`);
      return 1;
    }
    return 0;
  }

  if (command === "errored") {
    const [dir] = positionals;
    if (dir === undefined) {
      logError("usage: eval-gate errored <results-dir>");
      return 2;
    }
    try {
      const report = readRunDir(dir, files);
      if (report === undefined) throw new Error(`${dir} doesn't exist`);
      log(erroredIds(report).join(","));
      return 0;
    } catch (err) {
      logError(`eval-gate: ${(err as Error).message}`);
      return 2;
    }
  }

  if (command === "verdict") {
    const { results, baseline: baselineFile } = values;
    if (results === undefined || baselineFile === undefined) {
      logError("usage: eval-gate verdict --results <dir> --baseline <file>");
      return 2;
    }
    let verdict: Verdict;
    try {
      const baseline = parseBaseline(JSON.parse(files.readText(baselineFile)), baselineFile);
      const runsOf = (mode: Mode): ModeRuns => {
        const first = readRunDir(join(results, mode), files);
        if (first === undefined)
          throw new Error(`no ${mode} results in ${join(results, mode)} (did the run crash?)`);
        const rerun = readRunDir(join(results, `${mode}-rerun`), files);
        return { first, ...(rerun === undefined ? {} : { rerun }) };
      };
      verdict = gateVerdict(baseline, { l1: runsOf("l1"), scenario: runsOf("scenario") });
    } catch (err) {
      logError(`eval-gate: ${(err as Error).message}`);
      return 2;
    }
    const md = verdictMarkdown(verdict, baselineFile);
    log(md);
    const summaries = (["l1", "scenario", "l1-rerun", "scenario-rerun"] as const)
      .map((d) => runMarkdown(join(results, d), files))
      .filter(Boolean);
    toEnvFile("GITHUB_STEP_SUMMARY", `\n${md}\n\n${summaries.map(collapsed).join("\n")}`);
    if (!verdict.passed) {
      logError(`::error::Eval gate failed: ${verdict.failures.join("; ")}`);
      return 1;
    }
    return 0;
  }

  logError("usage: eval-gate plan|errored|verdict (see the header of scripts/eval-gate.ts)");
  return 2;
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) process.exitCode = main(process.argv.slice(2), process.env);
