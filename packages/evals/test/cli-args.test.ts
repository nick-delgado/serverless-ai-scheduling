/**
 * The `npm run evals` CLI's pure parts (`src/cli-args.ts`): argument validation, case selection, the
 * cost estimate, the results file name, and the exit code. `cli.ts` only wires these to the process.
 */
import { join } from "node:path";

import {
  estimateCostUsd,
  MODEL_PROFILE_NAMES,
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedText,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  caseSkipReason,
  CliArgError,
  DEFAULT_SIMULATOR_PROFILE,
  estimateRunCost,
  EXPECTED_SIMULATED_TURNS,
  exitCodeFor,
  judgeSetup,
  loadScenarios,
  parseCliArgs,
  resultsBasePath,
  selectCases,
  simulatorSetup,
  type SimulatorSetupDeps,
} from "../src";
import { l1Case, scenario } from "./helpers";

const OUT = "/tmp/evals-results";
const loaded = loadScenarios();
const profile = MODEL_PROFILES["gpt-oss-20b"];
const simProfile = MODEL_PROFILES["haiku-4.5"];
const simSetting = { name: "haiku-4.5", from: "--simulator-profile" };
/** No replay file is ever read unless a test passes its own reader. */
const deps = (readReplay: SimulatorSetupDeps["readReplay"] = () => ({ cases: [] })): SimulatorSetupDeps => ({
  llm: new ScriptedLlmClient(),
  readReplay,
});

describe("parseCliArgs", () => {
  it("defaults to the L1 smoke suite, one trial, a $1 budget", () => {
    expect(parseCliArgs([], OUT, {})).toEqual({
      suite: "smoke",
      mode: "l1",
      profile: MODEL_PROFILES["sonnet-4.6"],
      judge: true,
      calibrationDir: "/tmp/calibration",
      trials: 1,
      filters: [],
      maxCostUsd: 1,
      dryRun: false,
      out: OUT,
    });
  });

  // --export-calibration and --calibrate exclude each other, so the next test reads those two.
  it("reads every flag but the two calibration steps", () => {
    const args = parseCliArgs(
      [
        "--suite=full",
        "--mode=scenario",
        "--profile=nova-pro",
        "--simulator-profile=haiku-4.5",
        "--replay=/r.json",
        "--trials=3",
        "--filter= book , safety ,",
        "--max-cost=0.5",
        "--dry-run",
        "--out=/x",
        "--judge-profile=nova-pro",
        "--no-judge",
        "--calibration-dir=/c",
      ],
      OUT,
      {},
    );
    expect(args).toEqual({
      suite: "full",
      mode: "scenario",
      profile: MODEL_PROFILES["nova-pro"],
      simulatorProfile: { name: "haiku-4.5", from: "--simulator-profile" },
      replay: "/r.json",
      judge: false,
      judgeProfile: { name: "nova-pro", from: "--judge-profile" },
      calibrationDir: "/c",
      trials: 3,
      filters: ["book", "safety"],
      maxCostUsd: 0.5,
      dryRun: true,
      out: "/x",
    });
  });

  it("reads the calibration steps: the export with its results file, and the agreement (f6d8ff8/TEST-204)", () => {
    expect(parseCliArgs(["--export-calibration=/r.json"], OUT, {}).calibration).toEqual({
      action: "export",
      from: "/r.json",
    });
    expect(parseCliArgs(["--calibrate"], OUT, {}).calibration).toEqual({ action: "agreement" });
  });

  it.each([
    [["--trials=0"], "--trials must be a positive integer"],
    [["--trials=1.5"], "--trials must be a positive integer"],
    [["--suite=nightly"], "--suite must be smoke or full, got nightly"],
    [["--mode=both"], "--mode must be l1 or scenario, got both"],
    [["--max-cost=0"], "--max-cost must be a positive number of USD"],
    [["--max-cost=abc"], "--max-cost must be a positive number of USD"],
    [["--replay=/r.json"], "--replay needs --mode scenario"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv, OUT, {})).toThrow(new CliArgError(message));
  });

  it.each([
    ["--profile=sonet-4.6", /^Unknown --profile "sonet-4\.6"\. Expected one of: sonnet-4\.6, /],
    ["--profile=opus-5", /^--profile "opus-5" \(\S+\) is not entitled on this AWS account yet/],
  ])(
    "rejects %s as a usage error naming --profile, not AGENT_MODEL_PROFILE (8c21660/SPEC-1, #108)",
    (flag, message) => {
      expect(() => parseCliArgs([flag], OUT, {})).toThrow(CliArgError);
      expect(() => parseCliArgs([flag], OUT, {})).toThrow(message);
    },
  );

  it("trims a profile name, as resolveModelProfile does (#108)", () => {
    expect(parseCliArgs(["--profile= nova-pro "], OUT, {}).profile).toBe(MODEL_PROFILES["nova-pro"]);
  });

  it("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--trails=2"], OUT, {})).toThrow(CliArgError);
    expect(() => parseCliArgs(["--suite"], OUT, {})).toThrow(CliArgError); // a flag without its value
  });
});

describe("selectCases", () => {
  it("takes the mode's pool, the suite, then ids containing any filter", () => {
    const smokeL1 = selectCases(loaded, parseCliArgs([], OUT, {}));
    expect(smokeL1.length).toBeGreaterThan(0);
    expect(smokeL1.every((c) => c.category === "l1" && c.tags.includes("smoke"))).toBe(true);
    const filtered = selectCases(
      loaded,
      parseCliArgs(["--suite=full", "--mode=scenario", "--filter=emergency,dst"], OUT, {}),
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(
      filtered.every((c) => c.category !== "l1" && (c.id.includes("emergency") || c.id.includes("dst"))),
    ).toBe(true);
  });
});

describe("the simulator's profile (#31, #108)", () => {
  /** The simulator setup's profile for a scenario run with these arguments and environment. */
  const simulatorProfileFor = (argv: string[], env: Record<string, string>) => {
    const setup = simulatorSetup(parseCliArgs(["--mode=scenario", ...argv], OUT, env), deps());
    return setup.kind === "llm" ? setup.profile : undefined;
  };

  it("comes from SIMULATOR_MODEL_PROFILE when the flag is absent, and the flag wins over it", () => {
    const env = { SIMULATOR_MODEL_PROFILE: "nova-2-lite" };
    expect(simulatorProfileFor([], env)).toBe(MODEL_PROFILES["nova-2-lite"]);
    expect(simulatorProfileFor(["--simulator-profile=gpt-oss-120b"], env)).toBe(
      MODEL_PROFILES["gpt-oss-120b"],
    );
  });

  it("is sonnet-4.6 when neither the flag nor SIMULATOR_MODEL_PROFILE sets it, or either is empty (SPEC-2)", () => {
    expect(DEFAULT_SIMULATOR_PROFILE).toBe("sonnet-4.6");
    const sonnet = MODEL_PROFILES["sonnet-4.6"];
    expect(simulatorProfileFor([], {})).toBe(sonnet);
    expect(simulatorProfileFor([], { SIMULATOR_MODEL_PROFILE: " " })).toBe(sonnet);
    expect(simulatorProfileFor(["--simulator-profile="], { SIMULATOR_MODEL_PROFILE: "nova-pro" })).toBe(
      sonnet,
    );
  });

  it("is independent of the agent's --profile", () => {
    expect(simulatorProfileFor(["--profile=nova-pro"], {})).toBe(MODEL_PROFILES["sonnet-4.6"]);
  });

  it("a bad value is a usage error of a scenario run, naming the flag or variable that gave it (SMELL-205, r1/Q-3)", () => {
    expect(() => simulatorProfileFor([], { SIMULATOR_MODEL_PROFILE: "gpt-9" })).toThrow(
      new CliArgError(
        `Unknown SIMULATOR_MODEL_PROFILE "gpt-9". Expected one of: ${MODEL_PROFILE_NAMES.join(", ")}.`,
      ),
    );
    expect(() =>
      simulatorProfileFor(["--simulator-profile=sonnet-5"], { SIMULATOR_MODEL_PROFILE: "nova-pro" }),
    ).toThrow(/^--simulator-profile "sonnet-5" \(\S+\) is not entitled on this AWS account yet/);
  });

  it.each([
    ["an L1 run", []],
    ["a --replay run", ["--mode=scenario", "--replay=/r.json"]],
    ["the calibration export", ["--export-calibration=/r.json"]],
    ["--calibrate", ["--calibrate"]],
  ])("a bad value doesn't stop %s from parsing and setting up (SMELL-205)", (_run, argv) => {
    for (const [flags, env] of [
      [[], { SIMULATOR_MODEL_PROFILE: "gpt-9" }],
      [["--simulator-profile=opus-5"], {}],
    ] as const) {
      const args = parseCliArgs([...argv, ...flags], OUT, env);
      expect(simulatorSetup(args, deps()).kind).not.toBe("llm");
      expect(() => judgeSetup(args, { llm: new ScriptedLlmClient() })).not.toThrow();
    }
  });
});

describe("simulatorSetup (8bea70b/TEST-6)", () => {
  it("L1 mode has no simulator; the estimate assumes the script only", () => {
    expect(simulatorSetup({ mode: "l1", simulatorProfile: simSetting }, deps())).toEqual({
      kind: "script-only",
    });
  });

  it("scenario mode without --replay uses the LLM simulator on the simulator profile", () => {
    const setup = simulatorSetup({ mode: "scenario", simulatorProfile: simSetting }, deps());
    expect(setup).toMatchObject({ kind: "llm", profile: simProfile });
    expect(setup.simulator?.name).toBe("llm:haiku-4.5:sim.v1");
  });

  it("builds the LLM simulator on the client it is given, so it shares that client's rate limit (5765869/TEST-201)", async () => {
    const llm = new ScriptedLlmClient([scriptedText("need a derm appt next week")]);
    const setup = simulatorSetup(
      { mode: "scenario", simulatorProfile: simSetting },
      { llm, readReplay: () => ({ cases: [] }) },
    );
    const book = scenario("book-derm-next-week-afternoon");
    await setup.simulator?.next({ scenario: book, trial: 1, events: [], turn: 1, lastAssistantText: "" });
    expect(llm.requests.map((r) => r.modelId)).toEqual([simProfile.modelId]);
  });

  it("--replay reads that file and replays it, with no simulator profile in the estimate", () => {
    const read: string[] = [];
    const setup = simulatorSetup(
      { mode: "scenario", replay: "run.json", simulatorProfile: simSetting },
      deps((path) => {
        read.push(path);
        return { simulator: "llm:haiku-4.5:sim.v1", cases: [] };
      }),
    );
    expect(read).toEqual(["run.json"]);
    expect(setup).toEqual({ kind: "replay", simulator: expect.anything() as unknown });
    expect(setup.simulator?.name).toBe("replay:llm:haiku-4.5:sim.v1");
  });

  it("a replay file that can't be read or isn't a results file is a usage error naming it", () => {
    const args = { mode: "scenario", replay: "bad.json", simulatorProfile: simSetting } as const;
    const unreadable = deps(() => {
      throw new Error("ENOENT");
    });
    expect(() => simulatorSetup(args, unreadable)).toThrow(
      new CliArgError("--replay bad.json: Error: ENOENT"),
    );
    expect(() =>
      simulatorSetup(
        args,
        deps(() => ({ cases: "nope" })),
      ),
    ).toThrow(CliArgError);
  });
});

describe("estimateRunCost", () => {
  it("scales with trials and leaves out cases that will skip", () => {
    const l1 = selectCases(loaded, parseCliArgs(["--filter=l1-emergency-911"], OUT, {}));
    const one = estimateRunCost(l1, profile, 1);
    expect(one).toBeGreaterThan(0);
    expect(estimateRunCost(l1, profile, 3)).toBeCloseTo(one * 3, 12);
    const unscripted = selectCases(
      loaded,
      parseCliArgs(["--mode=scenario", "--filter=book-derm-next-week"], OUT, {}),
    );
    expect(unscripted).toHaveLength(1);
    expect(estimateRunCost(unscripted, profile, 1)).toBe(0); // script-only: it needs a simulator, so it won't run
  });

  it("a scripted scenario costs 3 calls per scripted turn per trial (2e22f79/TEST-301)", () => {
    const s = scenario("safety-emergency-chest-pain-911"); // one scripted turn
    const call = estimateCostUsd(profile, {
      inputTokens: 4000,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(estimateRunCost([s], profile, 1)).toBeCloseTo(3 * call, 12);
    const twoTurns = { ...s, script: [...(s.script ?? []), "ok, calling now"] };
    expect(estimateRunCost([twoTurns], profile, 2)).toBeCloseTo(3 * call * 2 * 2, 12);
  });

  describe("with a simulator (#31)", () => {
    const usage = (inputTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const agentCall = estimateCostUsd(profile, usage(4000, 400));
    const simCall = estimateCostUsd(simProfile, usage(1500, 150));
    const llm = simulatorSetup({ mode: "scenario", simulatorProfile: simSetting }, deps());
    const replay = simulatorSetup(
      { mode: "scenario", replay: "r.json", simulatorProfile: simSetting },
      deps(),
    );

    it("an unscripted scenario runs the expected simulated turns, each with one simulator call", () => {
      const s = scenario("book-derm-next-week-afternoon"); // max_turns 12, no script
      const turns = EXPECTED_SIMULATED_TURNS;
      expect(s.max_turns).toBeGreaterThan(turns);
      expect(estimateRunCost([s], profile, 2, llm)).toBeCloseTo((3 * agentCall + simCall) * turns * 2, 12);
    });

    it("turns are capped by max_turns, and scripted turns cost no simulator call", () => {
      const s = scenario("safety-emergency-chest-pain-911"); // max_turns 4, one scripted turn
      expect(s.max_turns).toBeLessThan(1 + EXPECTED_SIMULATED_TURNS);
      expect(estimateRunCost([s], profile, 1, llm)).toBeCloseTo(3 * agentCall * 4 + simCall * 3, 12);
    });

    it("a replay calls no simulator model; a covered_by scenario still skips, whatever its surface", () => {
      const s = scenario("safety-emergency-chest-pain-911");
      expect(estimateRunCost([s], profile, 1, replay)).toBeCloseTo(3 * agentCall * 4, 12);
      expect(estimateRunCost([scenario("safety-conversation-id-ownership")], profile, 1, llm)).toBe(0);
      const agentSurface = { ...s, covered_by: "services/api/test/chat-turn.test.ts" };
      expect(estimateRunCost([agentSurface], profile, 1, llm)).toBe(0);
    });
  });
});

describe("caseSkipReason (the CLI's skip lines)", () => {
  it("gives a covered_by scenario its coverage, and never skips an L1 case (#80)", () => {
    expect(caseSkipReason(scenario("safety-conversation-id-ownership"))).toBe(
      "covered outside the harness: services/api/test/chat-turn.test.ts",
    );
    expect(caseSkipReason(l1Case("l1-crisis-988"))).toBeUndefined();
  });
});

describe("resultsBasePath", () => {
  it("is <out>/<timestamp>-<mode>-<suite>-<profile>", () => {
    const report = {
      startedAt: "2026-10-01T17:32:26.123Z",
      mode: "l1",
      suite: "smoke",
      profile: "nova-pro",
    } as const;
    expect(resultsBasePath(report, OUT)).toBe(join(OUT, "2026-10-01T173226Z-l1-smoke-nova-pro"));
  });
});

describe("exitCodeFor", () => {
  it.each([
    [{ safetyViolations: 0, errored: 0 }, 0],
    [{ safetyViolations: 1, errored: 0 }, 1],
    [{ safetyViolations: 0, errored: 2 }, 1],
  ])("%j exits %i", (summary, code) => {
    expect(exitCodeFor(summary)).toBe(code);
  });
});
