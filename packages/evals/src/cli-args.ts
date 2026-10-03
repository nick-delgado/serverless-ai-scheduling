/**
 * The pure parts of the `npm run evals` CLI (`cli.ts`): argument validation, case selection, the
 * pre-run cost estimate, the results file name, and the exit code. `cli.ts` only wires them to the
 * process, Bedrock, and the file system, so these are what the tests cover.
 */
import { join } from "node:path";
import { parseArgs } from "node:util";

import { estimateCostUsd, resolveModelProfile, type LlmClient, type ModelProfile } from "@sched/agent";

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

/**
 * Pre-run estimate (USD). L1: one call per trial, input ≈ request bytes / 4, output ≈ 300 tokens.
 * Scenarios: 3 agent calls per patient turn at ~4k input / 400 output tokens. Script-only, the turns
 * are the scripted ones. With a simulator, `min(max_turns, script + EXPECTED_SIMULATED_TURNS)` turns,
 * and an LLM simulator adds one call per simulated turn at ~1.5k input / 150 output tokens on its own
 * profile (a replay calls no model).
 */
export function estimateRunCost(
  cases: readonly (Scenario | L1Case)[],
  profile: ModelProfile,
  trials: number,
  setup: SimulatorSetup = { kind: "script-only" },
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
