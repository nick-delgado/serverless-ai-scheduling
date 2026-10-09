/**
 * The testable parts of the `npm run evals` CLI (`cli.ts`): argument validation, case selection, the
 * simulator and judge setup, the pre-run cost estimate, the run's options, the results file name, the
 * exit code, the calibration step and its file adapters, the exit-report and baseline steps (#34), and the
 * usage-error mapping. `cli.ts` only calls these with the process, Bedrock and `console`, so these are what
 * the tests cover.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { z } from "zod";

import {
  DEFAULT_MODEL_PROFILE,
  estimateCostUsd,
  MODEL_PROFILE_ENV,
  resolveModelProfile,
  type LlmClient,
  type ModelProfile,
  type ModelProfileName,
} from "@sched/agent";

import {
  calibrationMarkdown,
  CalibrationSet,
  DEFAULT_JUDGE_PROFILE,
  exportCalibration,
  hasLabels,
  labelledDimensions,
  JUDGE_PROFILE_ENV,
  judgedDimensions,
  LabelsFile,
  LlmJudge,
  runCalibration,
  type CalibrationReport,
  type TrialJudge,
} from "./judge";
import { l1Request } from "./l1";
import {
  baselineFromReports,
  baselineJson,
  baselinePath,
  exitMarkdown,
  exitReport,
  parseRunReport,
  type Baseline,
  type ExitReport,
} from "./report";
import { selectSuite, SUITES, type LoadedScenarios, type Suite } from "./loader";
import { skipReason } from "./runner";
import { errorReason, issueText } from "./util";
import { isL1Case, type L1Case, type Scenario } from "./schema";
import {
  DEFAULT_SIMULATOR_PROFILE,
  LlmPatientSimulator,
  ReplayPatientSimulator,
  scriptOnlySimulator,
  SIMULATOR_PROFILE_ENV,
  type PatientSimulator,
} from "./simulator";
import type { RateLimitStats } from "./rate-limit";
import { MODES, type Mode, type RunReport, type RunSuiteOptions, type RunSummary } from "./suite";
import { promptFor } from "./system-prompt";

/** A model profile name as the command line gave it, unresolved, and the flag or variable that gave it. */
export interface ProfileSetting {
  name: string;
  /** `--profile`, `--simulator-profile` or `SIMULATOR_MODEL_PROFILE`, `--judge-profile` or `JUDGE_MODEL_PROFILE`. */
  from: string;
}

export interface CliArgs {
  suite: Suite;
  mode: Mode;
  /** The resolved `--profile` (default: the development default profile). */
  profile: ModelProfile;
  /**
   * The patient simulator's profile name (#31), from `--simulator-profile`, else `SIMULATOR_MODEL_PROFILE`;
   * unset or empty means `DEFAULT_SIMULATOR_PROFILE`. Resolved by `simulatorSetup` only for an
   * LLM-simulated scenario run, so a bad value can't break an L1, replay or calibration run (#108).
   */
  simulatorProfile?: ProfileSetting;
  /** Scenario mode: a results JSON whose recorded simulator turns are replayed instead (#31). */
  replay?: string;
  /** False with `--no-judge`: scenario trials aren't judged (#32). */
  judge: boolean;
  /**
   * The judge's profile name, from `--judge-profile`, else `JUDGE_MODEL_PROFILE`; unset means the default
   * (`haiku-4.5`). Resolved by `judgeSetup` only when a run will judge (r1/A-10).
   */
  judgeProfile?: ProfileSetting;
  /**
   * Calibration instead of a run (#32): `export` picks transcripts from a results file (no model calls);
   * `agreement` judges the labelled ones and reports judge–human agreement.
   */
  calibration?: { action: "export"; from: string } | { action: "agreement" };
  /** Where calibration reads and writes `transcripts.json` and `labels.json` (default `packages/evals/calibration`). */
  calibrationDir: string;
  /**
   * A step on saved results files instead of a run (#34), no model calls: `exit` writes the PRD §7 exit
   * table from one L1 and one scenario results file; `baseline` promotes them to the committed baseline.
   */
  resultsStep?: { action: "exit" | "baseline"; files: [string, string] };
  /** Where `--update-baseline` writes `<profile>.json` (`packages/evals/baselines`). */
  baselineDir: string;
  /** `--ids`: run exactly these case IDs (the CI gate's re-run of errored cases, r1/A-4). */
  ids: string[];
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

/** True when `value` is one of `list`'s strings. Shared with `matrix.ts`. */
export const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** `--suite`'s value, checked. Shared with `matrix.ts`. */
export function parseSuite(value: string): Suite {
  if (!isOneOf(SUITES, value)) throw new CliArgError(`--suite must be ${SUITES.join(" or ")}, got ${value}`);
  return value;
}

/** `--trials`'s value, checked. Shared with `matrix.ts`. */
export function parseTrials(value: string): number {
  const trials = Number(value);
  if (!Number.isInteger(trials) || trials < 1) throw new CliArgError("--trials must be a positive integer");
  return trials;
}

/** `--max-cost`'s value, checked. Shared with `matrix.ts`. */
export function parseMaxCost(value: string): number {
  const usd = Number(value);
  if (!(usd > 0)) throw new CliArgError("--max-cost must be a positive number of USD");
  return usd;
}

/**
 * A profile setting, resolved by `@sched/agent`'s `resolveModelProfile`, the one place that checks names
 * and entitlement. An empty or whitespace-only name means `fallback`. An unknown or unentitled name is a
 * usage error (exit 2), not a failed eval, and its message names the flag or variable that gave it in
 * place of `AGENT_MODEL_PROFILE` (#108, r1/Q-3, b4d4dab/SPEC-2).
 */
function resolveProfile({ name, from }: ProfileSetting, fallback: ModelProfileName): ModelProfile {
  try {
    return resolveModelProfile(name.trim() || fallback);
  } catch (error) {
    /* v8 ignore next -- resolveModelProfile throws only Error; anything else isn't a usage error, so it goes up as is */
    if (!(error instanceof Error)) throw error;
    throw new CliArgError(error.message.replace(MODEL_PROFILE_ENV, from));
  }
}

/** The flag's value, else the environment variable's, with where it came from; neither is `undefined`. */
function settingOf(
  flag: string,
  flagValue: string | undefined,
  envName: string,
  env: Readonly<Record<string, string | undefined>>,
): ProfileSetting | undefined {
  if (flagValue !== undefined) return { name: flagValue, from: flag };
  const envValue = env[envName];
  return envValue === undefined ? undefined : { name: envValue, from: envName };
}

/**
 * The results-file step and its two files, from the step flag and the positionals: none without a step flag
 * (then any positional is a usage error), and exactly two files with one.
 */
function resultsStepOf(
  action: "exit" | "baseline" | undefined,
  positionals: readonly string[],
): CliArgs["resultsStep"] {
  if (action === undefined) {
    if (positionals.length > 0) throw new CliArgError(`unexpected argument(s): ${positionals.join(" ")}`);
    return undefined;
  }
  const [first, second, ...rest] = positionals;
  if (first === undefined || second === undefined || rest.length > 0)
    throw new CliArgError(
      `${action === "exit" ? "--exit-report" : "--update-baseline"} takes two results files: <l1.json> <scenario.json>`,
    );
  return { action, files: [first, second] };
}

/** A comma-separated flag value as a list, blanks dropped. Shared with `matrix.ts`. */
export const splitList = (value: string | undefined): string[] =>
  value
    ?.split(",")
    .map((f) => f.trim())
    .filter(Boolean) ?? [];

/** Parse and validate `argv` (without the node and script paths). Throws `CliArgError`. */
export function parseCliArgs(
  argv: readonly string[],
  defaultOut: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        suite: { type: "string", default: "smoke" },
        mode: { type: "string", default: "l1" },
        profile: { type: "string" },
        "simulator-profile": { type: "string" },
        replay: { type: "string" },
        "judge-profile": { type: "string" },
        "no-judge": { type: "boolean", default: false },
        "export-calibration": { type: "string" },
        calibrate: { type: "boolean", default: false },
        "calibration-dir": { type: "string" },
        "exit-report": { type: "boolean", default: false },
        "update-baseline": { type: "boolean", default: false },
        ids: { type: "string" },
        trials: { type: "string", default: "1" },
        filter: { type: "string" },
        "max-cost": { type: "string", default: "1" },
        "dry-run": { type: "boolean", default: false },
        out: { type: "string", default: defaultOut },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    // An unknown flag or a missing value: a usage error (exit 2), not a failed eval.
    throw new CliArgError(errorReason(error));
  }
  const { values, positionals } = parsed;
  const { mode } = values;
  const suite = parseSuite(values.suite);
  if (!isOneOf(MODES, mode)) throw new CliArgError(`--mode must be ${MODES.join(" or ")}, got ${mode}`);
  const trials = parseTrials(values.trials);
  if (values.replay !== undefined && mode !== "scenario")
    throw new CliArgError("--replay needs --mode scenario");
  const exportFrom = values["export-calibration"];
  if (values.calibrate && values["no-judge"])
    throw new CliArgError("--calibrate needs the judge; drop --no-judge");
  const steps = [
    exportFrom === undefined ? [] : ["--export-calibration"],
    values.calibrate ? ["--calibrate"] : [],
    values["exit-report"] ? ["--exit-report"] : [],
    values["update-baseline"] ? ["--update-baseline"] : [],
  ].flat();
  if (steps.length > 1) throw new CliArgError(`${steps.join(" and ")} are separate steps; pass one`);
  const resultsStep = resultsStepOf(
    values["exit-report"] ? "exit" : values["update-baseline"] ? "baseline" : undefined,
    positionals,
  );
  const judgeProfile = settingOf("--judge-profile", values["judge-profile"], JUDGE_PROFILE_ENV, env);
  const simulatorProfile = settingOf(
    "--simulator-profile",
    values["simulator-profile"],
    SIMULATOR_PROFILE_ENV,
    env,
  );
  const maxCostUsd = parseMaxCost(values["max-cost"]);
  return {
    suite,
    mode,
    profile: resolveProfile({ name: values.profile ?? "", from: "--profile" }, DEFAULT_MODEL_PROFILE),
    ...(simulatorProfile === undefined ? {} : { simulatorProfile }),
    ...(values.replay === undefined ? {} : { replay: values.replay }),
    judge: !values["no-judge"],
    ...(judgeProfile === undefined ? {} : { judgeProfile }),
    ...(exportFrom !== undefined
      ? { calibration: { action: "export" as const, from: exportFrom } }
      : values.calibrate
        ? { calibration: { action: "agreement" as const } }
        : {}),
    calibrationDir: values["calibration-dir"] ?? join(dirname(defaultOut), "calibration"),
    ...(resultsStep === undefined ? {} : { resultsStep }),
    baselineDir: join(dirname(defaultOut), "baselines"),
    ids: splitList(values.ids),
    trials,
    filters: splitList(values.filter),
    maxCostUsd,
    dryRun: values["dry-run"],
    out: values.out,
  };
}

/**
 * The cases a run covers: the mode's pool, cut to the suite, then to ids containing any filter, then to
 * exactly the `--ids` given. An ID in `--ids` that isn't in the suite's pool for the mode is a usage error.
 */
export function selectCases(
  loaded: LoadedScenarios,
  args: Pick<CliArgs, "mode" | "suite" | "filters" | "ids">,
): (Scenario | L1Case)[] {
  const all: (Scenario | L1Case)[] = args.mode === "l1" ? loaded.l1 : loaded.scenarios;
  const pool = selectSuite(all, args.suite);
  const unknown = args.ids.filter((id) => !pool.some((c) => c.id === id));
  if (unknown.length > 0)
    throw new CliArgError(
      `--ids: no ${args.mode} case in the ${args.suite} suite has the ID ${unknown.join(", ")}`,
    );
  return pool.filter(
    (c) =>
      (args.filters.length === 0 || args.filters.some((f) => c.id.includes(f))) &&
      (args.ids.length === 0 || args.ids.includes(c.id)),
  );
}

/** Why a case won't run with this simulator (default: script-only), if it won't. */
export const caseSkipReason = (
  c: Scenario | L1Case,
  simulator: PatientSimulator = scriptOnlySimulator,
): string | undefined => (isL1Case(c) ? undefined : skipReason(c, simulator));

/**
 * Simulated patient turns a scenario is expected to take after its script (capped by `max_turns`). The
 * smoke runs of 2026-10-07 (below) took 1 to 6 turns, 3.4 on average.
 */
export const EXPECTED_SIMULATED_TURNS = 4;

/**
 * The scenario estimate's constants (#34, recalibrated from recorded runs: PR #97 decision 7 found the old
 * one about 8x high). They come from the `sonnet-4.6` scenario smoke runs of 2026-10-07 at prompt
 * `system.v1` (`…T140228Z-scenario-smoke-sonnet-4.6.json`, $0.34 with the judge, and
 * `…T142126Z-scenario-smoke-sonnet-4.6.json`, $0.39): 82 agent calls over 56 turns (1.5 a turn), each
 * reading ~6.25k cached tokens, writing ~450 and generating ~150; 66 simulator calls of ~950 input and ~20
 * output tokens, one more per conversation than its simulated turns (the stop). `packages/evals/test/
 * estimate-calibration.test.ts` pins the estimate between 1.0x and 1.5x of those runs, and of PR #165's full run.
 */
export const SCENARIO_ESTIMATE = {
  agentCallsPerTurn: 1.5,
  /** One agent call: the prompt it sends (cached, on a profile that caches messages) and what it writes. */
  agentCall: { promptTokens: 6700, cacheWriteTokens: 450, outputTokens: 160 },
  simulatorCall: { inputTokens: 1000, outputTokens: 20 },
} as const;

/**
 * The L1 estimate's constants (#34), from the five L1 smoke runs of 2026-10-07 (`sonnet-4.6`, `system.v1`,
 * $0.0567 to $0.0572 with a cold cache): ~105 output tokens a call, and a ~4.8k-token system-and-tools
 * prefix read from the cache after the first call wrote it. Each call also sent ~500 more uncached input
 * tokens than its messages' bytes / 4 (the system prompt's part after its cache point, and the framing).
 */
export const L1_ESTIMATE = { outputTokens: 150, uncachedOverheadTokens: 500 } as const;

/**
 * The patient side of a run, and what the estimate assumes about it: none beyond the script (L1 mode),
 * the LLM simulator on its own profile, or a replay of a results file (#31).
 */
export type SimulatorSetup =
  | { kind: "script-only"; simulator?: undefined }
  | { kind: "llm"; profile: ModelProfile; simulator: PatientSimulator }
  | { kind: "replay"; simulator: PatientSimulator };

/** What `simulatorSetup` needs from outside: the rate-limited client, and a reader for `--replay`. */
export interface SimulatorSetupDeps {
  llm: LlmClient;
  /** The parsed JSON of a results file. */
  readReplay: (path: string) => unknown;
}

/**
 * Pick the run's simulator from the arguments, once, for both the run and the estimate. Scenario mode
 * uses the LLM simulator on `simulatorProfile` (unset or empty: `DEFAULT_SIMULATOR_PROFILE`), or replays
 * `--replay`. The profile is resolved only on that LLM branch, so a bad `SIMULATOR_MODEL_PROFILE` can't
 * break any other run (#108). A bad profile, or a replay file that can't be read or isn't a results
 * file, is a usage error (exit 2).
 */
export function simulatorSetup(
  args: Pick<CliArgs, "mode" | "replay" | "simulatorProfile">,
  deps: SimulatorSetupDeps,
): SimulatorSetup {
  if (args.mode !== "scenario") return { kind: "script-only" };
  if (args.replay === undefined) {
    const profile = resolveProfile(
      args.simulatorProfile ?? { name: "", from: SIMULATOR_PROFILE_ENV },
      DEFAULT_SIMULATOR_PROFILE,
    );
    return { kind: "llm", profile, simulator: new LlmPatientSimulator({ llm: deps.llm, profile }) };
  }
  try {
    return { kind: "replay", simulator: ReplayPatientSimulator.fromReport(deps.readReplay(args.replay)) };
  } catch (error) {
    throw new CliArgError(`--replay ${args.replay}: ${errorReason(error)}`);
  }
}

/** The judge side of a run (#32): off, or the LLM judge on its profile. */
export type JudgeSetup = { kind: "off" } | { kind: "llm"; profile: ModelProfile; judge: TrialJudge };

/**
 * Pick the run's judge, once, for both the run and the estimate. Scenario runs and `--calibrate` judge,
 * on `judgeProfile` (default `haiku-4.5`) unless `--no-judge`; L1 runs and the calibration export never
 * do. The profile is resolved only then, so a bad `JUDGE_MODEL_PROFILE` can't break an L1 run (r1/A-10).
 */
export function judgeSetup(
  args: Pick<CliArgs, "mode" | "judge" | "judgeProfile" | "calibration">,
  deps: { llm: LlmClient },
): JudgeSetup {
  const judges =
    args.calibration === undefined ? args.mode === "scenario" : args.calibration.action === "agreement";
  if (!judges || !args.judge) return { kind: "off" };
  // An empty judge setting still means the development default, not the judge's (A-4's quirk, kept).
  const profile = resolveProfile(
    args.judgeProfile ?? { name: DEFAULT_JUDGE_PROFILE, from: "--judge-profile" },
    DEFAULT_MODEL_PROFILE,
  );
  return { kind: "llm", profile, judge: new LlmJudge({ llm: deps.llm, profile }) };
}

/** Judge calls a trial is expected to take: one, at ~6k input / 600 output tokens (r1/A-11). */
export const JUDGE_ESTIMATE_TOKENS = { input: 6000, output: 600 };

/** One call's estimated cost on `profile`, without prompt caching. */
const callCostUsd = (profile: ModelProfile, inputTokens: number, outputTokens: number): number =>
  estimateCostUsd(profile, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** One judge call's estimated cost on `profile`, at `JUDGE_ESTIMATE_TOKENS`. */
export const judgeCallEstimateUsd = (profile: ModelProfile): number =>
  callCostUsd(profile, JUDGE_ESTIMATE_TOKENS.input, JUDGE_ESTIMATE_TOKENS.output);

/**
 * One agent call in a scenario: on a profile that caches messages, the prompt is read from the cache but
 * for what the call writes to it; on any other, all of it is input.
 */
export function scenarioAgentCallUsd(profile: ModelProfile): number {
  const { promptTokens, cacheWriteTokens, outputTokens } = SCENARIO_ESTIMATE.agentCall;
  return profile.cachePoints.messages
    ? estimateCostUsd(profile, {
        inputTokens: 0,
        outputTokens,
        cacheReadTokens: promptTokens - cacheWriteTokens,
        cacheWriteTokens,
      })
    : callCostUsd(profile, promptTokens, outputTokens);
}

/**
 * Pre-run estimate (USD), recalibrated in #34 from recorded runs (`SCENARIO_ESTIMATE`).
 *
 * L1: one call per trial, input ≈ request bytes / 4, output `L1_ESTIMATE.outputTokens`. On a profile with a
 * system cache point, the system-and-tools prefix is written once per run and read from the cache after, and
 * the rest is input with `L1_ESTIMATE.uncachedOverheadTokens` added.
 *
 * Scenarios: script-only, the turns are the scripted ones. With a simulator, `min(max_turns, script +
 * EXPECTED_SIMULATED_TURNS)` turns. Each turn costs `agentCallsPerTurn` agent calls (`scenarioAgentCallUsd`).
 * An LLM simulator adds one call per simulated turn plus one for its stop, on its own profile (a replay calls
 * no model). With the judge on, one judge call per trial of a scenario that lists a rubric dimension, on the
 * judge's profile.
 */
export function estimateRunCost(
  cases: readonly (Scenario | L1Case)[],
  profile: ModelProfile,
  trials: number,
  setup: SimulatorSetup = { kind: "script-only" },
  judge: JudgeSetup = { kind: "off" },
): number {
  let estimate = 0;
  let prefixCached = false;
  for (const c of cases) {
    if (isL1Case(c)) {
      const req = l1Request(c, profile, promptFor(undefined, new Date(c.clock), undefined));
      const tokens = Math.ceil(JSON.stringify(req).length / 4);
      if (!profile.cachePoints.system) {
        estimate += callCostUsd(profile, tokens, L1_ESTIMATE.outputTokens) * trials;
        continue;
      }
      const prefix = Math.min(tokens, Math.ceil(JSON.stringify({ s: req.system, t: req.tools }).length / 4));
      const call = (cache: "read" | "write") =>
        estimateCostUsd(profile, {
          inputTokens: tokens - prefix + L1_ESTIMATE.uncachedOverheadTokens,
          outputTokens: L1_ESTIMATE.outputTokens,
          cacheReadTokens: cache === "read" ? prefix : 0,
          cacheWriteTokens: cache === "write" ? prefix : 0,
        });
      estimate += (prefixCached ? call("read") : call("write")) + call("read") * (trials - 1);
      prefixCached = true;
      continue;
    }
    // The same check as the CLI's printed skip list.
    if (caseSkipReason(c, setup.simulator) !== undefined) continue;
    const scripted = c.script?.length ?? 0;
    const turns =
      setup.kind === "script-only" ? scripted : Math.min(c.max_turns, scripted + EXPECTED_SIMULATED_TURNS);
    estimate += scenarioAgentCallUsd(profile) * SCENARIO_ESTIMATE.agentCallsPerTurn * turns * trials;
    if (setup.kind === "llm") {
      const { inputTokens, outputTokens } = SCENARIO_ESTIMATE.simulatorCall;
      estimate += callCostUsd(setup.profile, inputTokens, outputTokens) * (turns - scripted + 1) * trials;
    }
    if (judge.kind === "llm" && judgedDimensions(c).length > 0)
      estimate += judgeCallEstimateUsd(judge.profile) * trials;
  }
  return estimate;
}

/** An ISO timestamp as a file name stamp: `2026-10-05T11:27:57.123Z` → `2026-10-05T112757Z`. */
export const fileStamp = (iso: string): string => iso.replaceAll(":", "").replace(/\.\d+Z$/, "Z");

/** `<out>/<timestamp>-<mode>-<suite>-<profile>`, without the `.json` / `.md` extension. */
export function resultsBasePath(
  report: Pick<RunReport, "startedAt" | "mode" | "suite" | "profile">,
  outDir: string,
): string {
  return join(outDir, `${fileStamp(report.startedAt)}-${report.mode}-${report.suite}-${report.profile}`);
}

/** What `runOptions` wires besides the arguments: the client, its counters, the patient and the judge. */
export interface RunWiring {
  llm: LlmClient;
  /** The rate-limited client's counters, read into the report. */
  rateLimit: { readonly stats: RateLimitStats };
  setup: SimulatorSetup;
  judging: JudgeSetup;
  onTrial: NonNullable<RunSuiteOptions["onTrial"]>;
}

/** The `runSuite` options for a CLI run: the agent on `llm`, the simulator, and the judge when it's on. */
export function runOptions(
  args: Pick<CliArgs, "mode" | "suite" | "profile" | "trials" | "maxCostUsd">,
  wiring: RunWiring,
): RunSuiteOptions {
  const { simulator } = wiring.setup;
  const { judging } = wiring;
  return {
    mode: args.mode,
    suite: args.suite,
    llm: wiring.llm,
    llmName: "converse",
    profile: args.profile,
    trials: args.trials,
    maxCostUsd: args.maxCostUsd,
    rateLimit: wiring.rateLimit,
    ...(simulator === undefined ? {} : { simulator }),
    ...(judging.kind === "llm" ? { judge: { judge: judging.judge, profile: judging.profile } } : {}),
    onTrial: wiring.onTrial,
  };
}

/** Rethrow `error`, unless it is a `CliArgError`: that goes to `usage` (the CLI prints it and exits 2). */
function usageOrRethrow(error: unknown, usage: (message: string) => never): never {
  if (error instanceof CliArgError) usage(error.message);
  throw error;
}

/** Run one setup step; a `CliArgError` from it is a usage error, anything else is rethrown. */
export function orUsageError<T>(step: () => T, usage: (message: string) => never): T {
  try {
    return step();
  } catch (error) {
    return usageOrRethrow(error, usage);
  }
}

/** `orUsageError` for an async step, such as the calibration step. */
export async function orUsageErrorAsync<T>(
  step: () => Promise<T>,
  usage: (message: string) => never,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    return usageOrRethrow(error, usage);
  }
}

/**
 * 1 when the run had a safety violation or an errored case, else 0. A budget stop alone exits 0
 * (TEST-105 decision, PR #71): the report counts it. The CI eval gate (`scripts/eval-gate.ts`) doesn't read
 * this code: it decides from the results JSON, re-running errored cases once and failing on a budget stop
 * (#34, r1/A-4).
 */
export const exitCodeFor = (summary: Pick<RunSummary, "safetyViolations" | "errored">): 0 | 1 =>
  summary.safetyViolations > 0 || summary.errored > 0 ? 1 : 0;

/** What `calibrationStep` needs from outside: files, the scenarios, a clock and a log. */
export interface CalibrationDeps {
  /** Parsed JSON of a file, or `undefined` when it doesn't exist. */
  readJson: (path: string) => unknown;
  /** Write a file, creating its directory if needed. */
  writeFile: (path: string, text: string) => void;
  scenarios: readonly Scenario[];
  log: (line: string) => void;
  /** When the agreement report is stamped. */
  now: () => Date;
}

/** The file system calls the CLI's writes make: a directory with its parents, and a file. */
export interface FileWrites {
  mkdir: (dir: string) => void;
  writeFile: (path: string, text: string) => void;
}

/** The real file system, for the calibration step's files and the run's results (`results-copy.ts`). */
export const nodeFileWrites: FileWrites = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  writeFile: (path, text) => writeFileSync(path, text),
};

/** The calibration step's real files and clock, for `cli.ts`. */
export function fileCalibrationDeps(
  scenarios: readonly Scenario[],
  log: (line: string) => void,
): CalibrationDeps {
  return {
    readJson: (path) => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as unknown) : undefined),
    writeFile: (path, text) => {
      nodeFileWrites.mkdir(dirname(path));
      nodeFileWrites.writeFile(path, text);
    },
    scenarios,
    log,
    now: () => new Date(),
  };
}

/** Validate a calibration file against its schema; a bad file is a usage error. */
function parseFile<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  if (value === undefined) throw new CliArgError(`${path} doesn't exist`);
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliArgError(`${path}: ${parsed.error.issues.map(issueText).join("; ")}`);
}

/**
 * The calibration steps (#32). `export`: pick transcripts from `--export-calibration <results.json>` into
 * `<calibrationDir>/transcripts.json`, with an empty `labels.json`; it refuses to overwrite a labels file
 * that already holds scores. `agreement`: judge the labelled transcripts and write the report to
 * `<out>/<timestamp>-calibration-<judge profile>.{json,md}`; with `--dry-run`, only the estimate.
 * Returns the report, when one was written.
 */
export async function calibrationStep(
  args: Pick<CliArgs, "calibrationDir" | "out" | "dryRun"> & {
    calibration: NonNullable<CliArgs["calibration"]>;
  },
  judging: JudgeSetup,
  deps: CalibrationDeps,
): Promise<CalibrationReport | undefined> {
  const transcriptsPath = join(args.calibrationDir, "transcripts.json");
  const labelsPath = join(args.calibrationDir, "labels.json");
  // A file that can't be read or isn't JSON is a usage error naming it.
  const readJson = (path: string): unknown => {
    try {
      return deps.readJson(path);
    } catch (error) {
      throw new CliArgError(`${path}: ${errorReason(error)}`);
    }
  };
  if (args.calibration.action === "export") {
    const { from } = args.calibration;
    const existing = readJson(labelsPath);
    if (existing !== undefined && hasLabels(parseFile(LabelsFile, existing, labelsPath)))
      throw new CliArgError(`${labelsPath} already holds labels; move it away before exporting again`);
    const source = readJson(from);
    if (source === undefined) throw new CliArgError(`${from} doesn't exist`);
    let exported;
    try {
      exported = await exportCalibration(source, deps.scenarios, from);
    } catch (error) {
      throw new CliArgError(`--export-calibration ${from}: ${errorReason(error)}`);
    }
    deps.writeFile(transcriptsPath, `${JSON.stringify(exported.set, null, 2)}\n`);
    deps.writeFile(labelsPath, `${JSON.stringify(exported.labels, null, 2)}\n`);
    deps.log(
      `evals: exported ${exported.set.transcripts.length} transcript(s) to ${transcriptsPath}; label them in ${labelsPath}`,
    );
    return undefined;
  }
  if (judging.kind !== "llm") throw new CliArgError("--calibrate needs the judge");
  const set = parseFile(CalibrationSet, readJson(transcriptsPath), transcriptsPath);
  const labels = parseFile(LabelsFile, readJson(labelsPath), labelsPath);
  if (!hasLabels(labels)) throw new CliArgError(`${labelsPath} has no scores yet (#159)`);
  const labelled = set.transcripts.filter((t) => labelledDimensions(labels, t).length > 0);
  const estimate = judgeCallEstimateUsd(judging.profile) * labelled.length;
  deps.log(
    `evals: calibrating ${judging.judge.name} (${judging.profile.modelId}) on ${labelled.length} labelled transcript(s). Estimated cost ≈ $${estimate.toFixed(4)}.`,
  );
  if (args.dryRun) return undefined;
  const report = await runCalibration(set, labels, judging.judge, deps.now);
  const base = join(args.out, `${fileStamp(report.judgedAt)}-calibration-${judging.profile.name}`);
  const md = calibrationMarkdown(report);
  deps.writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  deps.writeFile(`${base}.md`, `${md}\n`);
  deps.log(`\n${md}\n\nevals: wrote ${base}.json`);
  return report;
}

/** What the results-file steps need from outside: reading JSON, writing a file, a log. */
export type ResultsStepDeps = Pick<CalibrationDeps, "readJson" | "writeFile" | "log">;

/** Read and check the step's two results files; a missing or malformed one is a usage error naming it. */
function readResultsPair(files: readonly [string, string], deps: ResultsStepDeps): [RunReport, RunReport] {
  const read = (path: string): RunReport => {
    let value: unknown;
    try {
      value = deps.readJson(path);
    } catch (error) {
      throw new CliArgError(`${path}: ${errorReason(error)}`);
    }
    if (value === undefined) throw new CliArgError(`${path} doesn't exist`);
    try {
      return parseRunReport(value, path);
    } catch (error) {
      throw new CliArgError(errorReason(error).replace(/^Error: /, ""));
    }
  };
  return [read(files[0]), read(files[1])];
}

/** Run a report-building function; its `Error` is a usage error (the files don't fit the step). */
function asUsage<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    throw new CliArgError((error as Error).message);
  }
}

/**
 * `--exit-report <a.json> <b.json>` (#34, r1/Q-4 (a)): the PRD §7 exit table from one L1 and one scenario
 * results file, told apart by their `mode`, with no model calls. Writes
 * `<out>/<scenario run's stamp>-exit-<profile>.{json,md}` and logs the markdown.
 */
export function exitReportStep(
  args: Pick<CliArgs, "out"> & { files: [string, string] },
  deps: ResultsStepDeps,
): ExitReport {
  const reports = readResultsPair(args.files, deps);
  const report = asUsage(() => exitReport(reports));
  const base = writeExitReport(report, args.out, deps.writeFile);
  deps.log(`${exitMarkdown(report)}\n\nevals: wrote ${base}.json`);
  return report;
}

/**
 * Write an exit table as `<out>/<scenario run's stamp>-exit-<profile>.{json,md}`; returns the path without the
 * extension. The `--exit-report` step and the matrix (one per cell) both write through it.
 */
export function writeExitReport(
  report: ExitReport,
  out: string,
  writeFile: ResultsStepDeps["writeFile"],
): string {
  const base = join(out, `${fileStamp(report.startedAt)}-exit-${report.profile}`);
  writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFile(`${base}.md`, `${exitMarkdown(report)}\n`);
  return base;
}

/** Run the command line's results-file step (`--exit-report` or `--update-baseline`) on its two files. */
export function resultsStep(
  args: Pick<CliArgs, "out" | "baselineDir"> & { resultsStep: NonNullable<CliArgs["resultsStep"]> },
  deps: ResultsStepDeps,
): void {
  const { action, files } = args.resultsStep;
  if (action === "exit") exitReportStep({ out: args.out, files }, deps);
  else updateBaselineStep({ baselineDir: args.baselineDir, files }, deps);
}

/**
 * `--update-baseline <a.json> <b.json>` (#34, r1/A-2): promote one L1 and one scenario smoke run at k=1 to
 * `<baselineDir>/<profile>.json`, with no model calls. It refuses other suites, other trial counts, two
 * profiles, or a budget-stopped case.
 */
export function updateBaselineStep(
  args: Pick<CliArgs, "baselineDir"> & { files: [string, string] },
  deps: ResultsStepDeps,
): Baseline {
  const baseline = asUsage(() => baselineFromReports(readResultsPair(args.files, deps)));
  const path = baselinePath(args.baselineDir, baseline.profile);
  deps.writeFile(path, baselineJson(baseline));
  const { l1, scenario } = baseline.modes;
  deps.log(
    `evals: wrote ${path}: l1 ${l1.passed}/${l1.cases} passed, scenario ${scenario.passed}/${scenario.cases} passed`,
  );
  return baseline;
}
