/**
 * The pure parts of the `npm run evals` CLI (`cli.ts`): argument validation, case selection, the
 * pre-run cost estimate, the results file name, and the exit code. `cli.ts` only wires them to the
 * process, Bedrock, and the file system, so these are what the tests cover.
 */
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { z } from "zod";

import { estimateCostUsd, resolveModelProfile, type LlmClient, type ModelProfile } from "@sched/agent";

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
import { selectSuite, SUITES, type LoadedScenarios, type Suite } from "./loader";
import { skipReason } from "./runner";
import { errorReason } from "./util";
import { isL1Case, type L1Case, type Scenario } from "./schema";
import {
  LlmPatientSimulator,
  ReplayPatientSimulator,
  scriptOnlySimulator,
  SIMULATOR_PROFILE_ENV,
  type PatientSimulator,
} from "./simulator";
import { MODES, type Mode, type RunReport, type RunSummary } from "./suite";
import { promptFor } from "./system-prompt";

export interface CliArgs {
  suite: Suite;
  mode: Mode;
  /** The resolved `--profile` (default: the development default profile). */
  profile: ModelProfile;
  /**
   * Scenario mode: the patient simulator's profile (#31), from `--simulator-profile`, else
   * `SIMULATOR_MODEL_PROFILE`, else the development default. Unused with `--replay`.
   */
  simulatorProfile: ModelProfile;
  /** Scenario mode: a results JSON whose recorded simulator turns are replayed instead (#31). */
  replay?: string;
  /** False with `--no-judge`: scenario trials aren't judged (#32). */
  judge: boolean;
  /**
   * The judge's profile name, from `--judge-profile`, else `JUDGE_MODEL_PROFILE`; unset means the default
   * (`haiku-4.5`). Resolved by `judgeSetup` only when a run will judge (r1/A-10).
   */
  judgeProfile?: string;
  /**
   * Calibration instead of a run (#32): `export` picks transcripts from a results file (no model calls);
   * `agreement` judges the labelled ones and reports judge–human agreement.
   */
  calibration?: { action: "export"; from: string } | { action: "agreement" };
  /** Where calibration reads and writes `transcripts.json` and `labels.json` (default `packages/evals/calibration`). */
  calibrationDir: string;
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

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/** `--profile`, resolved: an unknown or unentitled name is a usage error (exit 2), not a failed eval. */
function resolveProfile(name: string | undefined, flag = "--profile"): ModelProfile {
  try {
    return resolveModelProfile(name);
  } catch (error) {
    throw new CliArgError(`${flag}: ${errorReason(error)}`);
  }
}

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
        trials: { type: "string", default: "1" },
        filter: { type: "string" },
        "max-cost": { type: "string", default: "1" },
        "dry-run": { type: "boolean", default: false },
        out: { type: "string", default: defaultOut },
      },
      strict: true,
    });
  } catch (error) {
    // An unknown flag or a missing value: a usage error (exit 2), not a failed eval.
    throw new CliArgError(errorReason(error));
  }
  const { values } = parsed;
  const { suite, mode } = values;
  if (!isOneOf(SUITES, suite)) throw new CliArgError(`--suite must be ${SUITES.join(" or ")}, got ${suite}`);
  if (!isOneOf(MODES, mode)) throw new CliArgError(`--mode must be ${MODES.join(" or ")}, got ${mode}`);
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1) throw new CliArgError("--trials must be a positive integer");
  if (values.replay !== undefined && mode !== "scenario")
    throw new CliArgError("--replay needs --mode scenario");
  const exportFrom = values["export-calibration"];
  if (exportFrom !== undefined && values.calibrate)
    throw new CliArgError("--export-calibration and --calibrate are separate steps; pass one");
  if (values.calibrate && values["no-judge"])
    throw new CliArgError("--calibrate needs the judge; drop --no-judge");
  const judgeProfile = values["judge-profile"] ?? env[JUDGE_PROFILE_ENV];
  const maxCostUsd = Number(values["max-cost"]);
  if (!(maxCostUsd > 0)) throw new CliArgError("--max-cost must be a positive number of USD");
  return {
    suite,
    mode,
    profile: resolveProfile(values.profile),
    simulatorProfile: resolveProfile(
      values["simulator-profile"] ?? env[SIMULATOR_PROFILE_ENV],
      "--simulator-profile",
    ),
    ...(values.replay === undefined ? {} : { replay: values.replay }),
    judge: !values["no-judge"],
    ...(judgeProfile === undefined ? {} : { judgeProfile }),
    ...(exportFrom !== undefined
      ? { calibration: { action: "export" as const, from: exportFrom } }
      : values.calibrate
        ? { calibration: { action: "agreement" as const } }
        : {}),
    calibrationDir: values["calibration-dir"] ?? join(dirname(defaultOut), "calibration"),
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

/** Why a case won't run with this simulator (default: script-only), if it won't. */
export const caseSkipReason = (
  c: Scenario | L1Case,
  simulator: PatientSimulator = scriptOnlySimulator,
): string | undefined => (isL1Case(c) ? undefined : skipReason(c, simulator));

/** Simulated patient turns a scenario is expected to take after its script (capped by `max_turns`). */
export const EXPECTED_SIMULATED_TURNS = 6;

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
 * uses the LLM simulator on `simulatorProfile`, or replays `--replay`. A replay file that can't be read
 * or isn't a results file is a usage error (exit 2).
 */
export function simulatorSetup(
  args: Pick<CliArgs, "mode" | "replay" | "simulatorProfile">,
  deps: SimulatorSetupDeps,
): SimulatorSetup {
  if (args.mode !== "scenario") return { kind: "script-only" };
  if (args.replay === undefined)
    return {
      kind: "llm",
      profile: args.simulatorProfile,
      simulator: new LlmPatientSimulator({ llm: deps.llm, profile: args.simulatorProfile }),
    };
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
  const profile = resolveProfile(args.judgeProfile ?? DEFAULT_JUDGE_PROFILE, "--judge-profile");
  return { kind: "llm", profile, judge: new LlmJudge({ llm: deps.llm, profile }) };
}

/** Judge calls a trial is expected to take: one, at ~6k input / 600 output tokens (r1/A-11). */
export const JUDGE_ESTIMATE_TOKENS = { input: 6000, output: 600 };

/**
 * Pre-run estimate (USD). L1: one call per trial, input ≈ request bytes / 4, output ≈ 300 tokens.
 * Scenarios: 3 agent calls per patient turn at ~4k input / 400 output tokens. Script-only, the turns
 * are the scripted ones. With a simulator, `min(max_turns, script + EXPECTED_SIMULATED_TURNS)` turns,
 * and an LLM simulator adds one call per simulated turn at ~1.5k input / 150 output tokens on its own
 * profile (a replay calls no model). With the judge on, one judge call per trial of a scenario that lists
 * a rubric dimension, on the judge's profile.
 */
export function estimateRunCost(
  cases: readonly (Scenario | L1Case)[],
  profile: ModelProfile,
  trials: number,
  setup: SimulatorSetup = { kind: "script-only" },
  judge: JudgeSetup = { kind: "off" },
): number {
  const cost = (p: ModelProfile, inputTokens: number, outputTokens: number) =>
    estimateCostUsd(p, { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  let estimate = 0;
  for (const c of cases) {
    if (isL1Case(c)) {
      const req = l1Request(c, profile, promptFor(undefined, new Date(c.clock), undefined));
      estimate += cost(profile, Math.ceil(JSON.stringify(req).length / 4), 300) * trials;
      continue;
    }
    // The same check as the CLI's printed skip list.
    if (caseSkipReason(c, setup.simulator) !== undefined) continue;
    const scripted = c.script?.length ?? 0;
    const turns =
      setup.kind === "script-only" ? scripted : Math.min(c.max_turns, scripted + EXPECTED_SIMULATED_TURNS);
    estimate += cost(profile, 4000, 400) * 3 * turns * trials;
    if (setup.kind === "llm") estimate += cost(setup.profile, 1500, 150) * (turns - scripted) * trials;
    if (judge.kind === "llm" && judgedDimensions(c).length > 0)
      estimate += cost(judge.profile, JUDGE_ESTIMATE_TOKENS.input, JUDGE_ESTIMATE_TOKENS.output) * trials;
  }
  return estimate;
}

/** `<out>/<timestamp>-<mode>-<suite>-<profile>`, without the `.json` / `.md` extension. */
export function resultsBasePath(
  report: Pick<RunReport, "startedAt" | "mode" | "suite" | "profile">,
  outDir: string,
): string {
  const stamp = report.startedAt.replaceAll(":", "").replace(/\.\d+Z$/, "Z");
  return join(outDir, `${stamp}-${report.mode}-${report.suite}-${report.profile}`);
}

/**
 * 1 when the run had a safety violation or an errored case, else 0. A budget stop alone exits 0
 * (TEST-105 decision, PR #71): the report counts it, and #34's gate decides what to do with it.
 */
export const exitCodeFor = (summary: Pick<RunSummary, "safetyViolations" | "errored">): 0 | 1 =>
  summary.safetyViolations > 0 || summary.errored > 0 ? 1 : 0;

/** What `calibrationStep` needs from outside: files, the scenarios, a clock and a log. */
export interface CalibrationDeps {
  /** Parsed JSON of a file, or `undefined` when it doesn't exist. */
  readJson: (path: string) => unknown;
  writeFile: (path: string, text: string) => void;
  scenarios: readonly Scenario[];
  log: (line: string) => void;
}

/** Validate a calibration file against its schema; a bad file is a usage error. */
function parseFile<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  if (value === undefined) throw new CliArgError(`${path} doesn't exist`);
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  throw new CliArgError(
    `${path}: ${issue?.path.map(String).join(".") || "(root)"}: ${issue?.message ?? "invalid"}`,
  );
}

/**
 * The calibration steps (#32). `export`: pick transcripts from `--export-calibration <results.json>` into
 * `<calibrationDir>/transcripts.json`, with an empty `labels.json`; it refuses to overwrite a labels file
 * that already holds scores. `agreement`: judge the labelled transcripts and write the report to
 * `<out>/<timestamp>-calibration-<judge profile>.{json,md}`; with `--dry-run`, only the estimate.
 * Returns the report, when one was written.
 */
export async function calibrationStep(
  args: Pick<CliArgs, "calibration" | "calibrationDir" | "out" | "dryRun">,
  judging: JudgeSetup,
  deps: CalibrationDeps,
): Promise<CalibrationReport | undefined> {
  const transcriptsPath = join(args.calibrationDir, "transcripts.json");
  const labelsPath = join(args.calibrationDir, "labels.json");
  if (args.calibration?.action === "export") {
    const { from } = args.calibration;
    const existing = deps.readJson(labelsPath);
    if (existing !== undefined && hasLabels(parseFile(LabelsFile, existing, labelsPath)))
      throw new CliArgError(`${labelsPath} already holds labels; move it away before exporting again`);
    let exported;
    try {
      exported = await exportCalibration(deps.readJson(from) ?? null, deps.scenarios, from);
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
  const set = parseFile(CalibrationSet, deps.readJson(transcriptsPath), transcriptsPath) as CalibrationSet;
  const labels = parseFile(LabelsFile, deps.readJson(labelsPath), labelsPath);
  if (!hasLabels(labels)) throw new CliArgError(`${labelsPath} has no scores yet (#159)`);
  const labelled = set.transcripts.filter((t) => labelledDimensions(labels, t).length > 0);
  const estimate =
    estimateCostUsd(judging.profile, {
      inputTokens: JUDGE_ESTIMATE_TOKENS.input,
      outputTokens: JUDGE_ESTIMATE_TOKENS.output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }) * labelled.length;
  deps.log(
    `evals: calibrating ${judging.judge.name} (${judging.profile.modelId}) on ${labelled.length} labelled transcript(s). Estimated cost ≈ $${estimate.toFixed(4)}.`,
  );
  if (args.dryRun) return undefined;
  const report = await runCalibration(set, labels, judging.judge);
  const base = join(
    args.out,
    `${report.judgedAt.replaceAll(":", "").replace(/\.\d+Z$/, "Z")}-calibration-${judging.profile.name}`,
  );
  const md = calibrationMarkdown(report);
  deps.writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  deps.writeFile(`${base}.md`, `${md}\n`);
  deps.log(`\n${md}\n\nevals: wrote ${base}.json`);
  return report;
}
