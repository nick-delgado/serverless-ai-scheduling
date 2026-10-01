/**
 * The pure parts of the `npm run evals` CLI (`cli.ts`): argument validation, case selection, the
 * pre-run cost estimate, the results file name, and the exit code. `cli.ts` only wires them to the
 * process, Bedrock, and the file system, so these are what the tests cover.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import { estimateCostUsd, type ModelProfile } from "@sched/agent";

import { l1Request } from "./l1";
import { selectSuite, type LoadedScenarios, type Suite } from "./loader";
import { skipReason } from "./runner";
import { isL1Case, type L1Case, type Scenario } from "./schema";
import { scriptOnlySimulator } from "./simulator";
import type { Mode, RunReport, RunSummary } from "./suite";
import { interimSystemPrompt } from "./system-prompt";

export interface CliArgs {
  suite: Suite;
  mode: Mode;
  /** Model profile name; `undefined` means the development default. */
  profile: string | undefined;
  trials: number;
  filters: string[];
  maxCostUsd: number;
  dryRun: boolean;
  out: string;
}

/** A bad command line: the CLI prints the message and exits 2. */
export class CliArgError extends Error {
  override readonly name = "CliArgError";
}

/** Parse and validate `argv` (without the node and script paths). Throws `CliArgError`. */
export function parseCliArgs(argv: readonly string[], defaultOut: string): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      suite: { type: "string", default: "smoke" },
      mode: { type: "string", default: "l1" },
      profile: { type: "string" },
      trials: { type: "string", default: "1" },
      filter: { type: "string" },
      "max-cost": { type: "string", default: "1" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string", default: defaultOut },
    },
    strict: true,
  });
  const { suite, mode } = values;
  if (suite !== "smoke" && suite !== "full")
    throw new CliArgError(`--suite must be smoke or full, got ${suite}`);
  if (mode !== "l1" && mode !== "scenario")
    throw new CliArgError(`--mode must be l1 or scenario, got ${mode}`);
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1) throw new CliArgError("--trials must be a positive integer");
  const maxCostUsd = Number(values["max-cost"]);
  if (!(maxCostUsd > 0)) throw new CliArgError("--max-cost must be a positive number of USD");
  return {
    suite,
    mode,
    profile: values.profile,
    trials,
    filters:
      values.filter
        ?.split(",")
        .map((f) => f.trim())
        .filter(Boolean) ?? [],
    maxCostUsd,
    dryRun: values["dry-run"],
    out: values.out,
  };
}

/** The cases a run covers: the mode's pool, cut to the suite, then to ids containing any filter. */
export function selectCases(loaded: LoadedScenarios, args: CliArgs): (Scenario | L1Case)[] {
  const pool: (Scenario | L1Case)[] = args.mode === "l1" ? loaded.l1 : loaded.scenarios;
  return selectSuite(pool, args.suite).filter(
    (c) => args.filters.length === 0 || args.filters.some((f) => c.id.includes(f)),
  );
}

/** Why a case won't run in this configuration (scenario mode, no simulator yet), if it won't. */
export const caseSkipReason = (c: Scenario | L1Case): string | undefined =>
  isL1Case(c) ? undefined : skipReason(c, scriptOnlySimulator);

/**
 * Pre-run estimate (USD). L1: one call per trial, input ≈ request bytes / 4, output ≈ 300 tokens.
 * Scenarios (scripted turns only until #31): 3 calls per scripted turn at ~4k input / 400 output tokens.
 */
export function estimateRunCost(
  cases: readonly (Scenario | L1Case)[],
  profile: ModelProfile,
  trials: number,
): number {
  const cost = (inputTokens: number, outputTokens: number) =>
    estimateCostUsd(profile, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  let estimate = 0;
  for (const c of cases) {
    if (caseSkipReason(c) !== undefined) continue;
    if (isL1Case(c)) {
      const req = l1Request(c, profile, interimSystemPrompt(new Date(c.clock), "Patient"));
      estimate += cost(Math.ceil(JSON.stringify(req).length / 4), 300) * trials;
    } else estimate += cost(4000, 400) * 3 * (c.script?.length ?? 0) * trials;
  }
  return estimate;
}

/** `<out>/<timestamp>-<mode>-<suite>-<profile>`, without the `.json` / `.md` extension. */
export function resultsBasePath(report: RunReport, outDir: string): string {
  const stamp = report.startedAt.replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return join(outDir, `${stamp}-${report.mode}-${report.suite}-${report.profile}`);
}

/**
 * 1 when the run had a safety violation or an errored case, else 0. A budget stop alone exits 0
 * (TEST-105 decision, PR #71): the report counts it, and #34's gate decides what to do with it.
 */
export const exitCodeFor = (summary: RunSummary): 0 | 1 =>
  summary.safetyViolations > 0 || summary.errored > 0 ? 1 : 0;
