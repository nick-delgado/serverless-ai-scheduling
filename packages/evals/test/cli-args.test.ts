/**
 * The `npm run evals` CLI's pure parts (`src/cli-args.ts`): argument validation, case selection, the
 * cost estimate, the results file name, and the exit code. `cli.ts` only wires these to the process.
 */
import { join } from "node:path";

import { estimateCostUsd, MODEL_PROFILES } from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  CliArgError,
  estimateRunCost,
  EXPECTED_SIMULATED_TURNS,
  exitCodeFor,
  loadScenarios,
  parseCliArgs,
  resultsBasePath,
  selectCases,
} from "../src";
import { scenario } from "./helpers";

const OUT = "/tmp/evals-results";
const loaded = loadScenarios();
const profile = MODEL_PROFILES["gpt-oss-20b"];

describe("parseCliArgs", () => {
  it("defaults to the L1 smoke suite, one trial, a $1 budget", () => {
    expect(parseCliArgs([], OUT, {})).toEqual({
      suite: "smoke",
      mode: "l1",
      profile: MODEL_PROFILES["sonnet-4.6"],
      simulatorProfile: MODEL_PROFILES["sonnet-4.6"],
      trials: 1,
      filters: [],
      maxCostUsd: 1,
      dryRun: false,
      out: OUT,
    });
  });

  it("reads every flag", () => {
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
      ],
      OUT,
    );
    expect(args).toEqual({
      suite: "full",
      mode: "scenario",
      profile: MODEL_PROFILES["nova-pro"],
      simulatorProfile: MODEL_PROFILES["haiku-4.5"],
      replay: "/r.json",
      trials: 3,
      filters: ["book", "safety"],
      maxCostUsd: 0.5,
      dryRun: true,
      out: "/x",
    });
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
    expect(() => parseCliArgs(argv, OUT)).toThrow(new CliArgError(message));
  });

  it.each([
    ["--profile=sonet-4.6", /^--profile: Error: Unknown AGENT_MODEL_PROFILE "sonet-4\.6"/],
    ["--profile=opus-5", /^--profile: Error: AGENT_MODEL_PROFILE "opus-5" .* is not entitled/],
  ])("rejects %s as a usage error (8c21660/SPEC-1)", (flag, message) => {
    expect(() => parseCliArgs([flag], OUT)).toThrow(CliArgError);
    expect(() => parseCliArgs([flag], OUT)).toThrow(message);
  });

  it("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--trails=2"], OUT)).toThrow(CliArgError);
    expect(() => parseCliArgs(["--suite"], OUT)).toThrow(CliArgError); // a flag without its value
  });
});

describe("selectCases", () => {
  it("takes the mode's pool, the suite, then ids containing any filter", () => {
    const smokeL1 = selectCases(loaded, parseCliArgs([], OUT));
    expect(smokeL1.length).toBeGreaterThan(0);
    expect(smokeL1.every((c) => c.category === "l1" && c.tags.includes("smoke"))).toBe(true);
    const filtered = selectCases(
      loaded,
      parseCliArgs(["--suite=full", "--mode=scenario", "--filter=emergency,dst"], OUT),
    );
    expect(filtered.length).toBeGreaterThan(0);
    expect(
      filtered.every((c) => c.category !== "l1" && (c.id.includes("emergency") || c.id.includes("dst"))),
    ).toBe(true);
  });
});

describe("parseCliArgs: the simulator's profile (#31)", () => {
  it("comes from SIMULATOR_MODEL_PROFILE when the flag is absent, and the flag wins over it", () => {
    const env = { SIMULATOR_MODEL_PROFILE: "nova-2-lite" };
    expect(parseCliArgs([], OUT, env).simulatorProfile).toBe(MODEL_PROFILES["nova-2-lite"]);
    expect(parseCliArgs(["--simulator-profile=gpt-oss-120b"], OUT, env).simulatorProfile).toBe(
      MODEL_PROFILES["gpt-oss-120b"],
    );
  });

  it("is independent of the agent's --profile", () => {
    expect(parseCliArgs(["--profile=nova-pro"], OUT, {}).simulatorProfile).toBe(MODEL_PROFILES["sonnet-4.6"]);
  });

  it("rejects an unknown or unentitled profile as a usage error", () => {
    expect(() => parseCliArgs(["--simulator-profile=sonnet-5"], OUT, {})).toThrow(CliArgError);
    expect(() => parseCliArgs([], OUT, { SIMULATOR_MODEL_PROFILE: "gpt-9" })).toThrow(
      /^--simulator-profile: .*Unknown .*"gpt-9"/,
    );
  });
});

describe("estimateRunCost", () => {
  it("scales with trials and leaves out cases that will skip", () => {
    const l1 = selectCases(loaded, parseCliArgs(["--filter=l1-emergency-911"], OUT));
    const one = estimateRunCost(l1, profile, 1);
    expect(one).toBeGreaterThan(0);
    expect(estimateRunCost(l1, profile, 3)).toBeCloseTo(one * 3, 12);
    const unscripted = selectCases(
      loaded,
      parseCliArgs(["--mode=scenario", "--filter=book-derm-next-week"], OUT),
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
    const simProfile = MODEL_PROFILES["haiku-4.5"];
    const simCall = estimateCostUsd(simProfile, usage(1500, 150));
    const llm = { kind: "llm", profile: simProfile } as const;

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

    it("a replay calls no simulator model; a surface: api scenario still skips", () => {
      const s = scenario("safety-emergency-chest-pain-911");
      expect(estimateRunCost([s], profile, 1, { kind: "replay" })).toBeCloseTo(3 * agentCall * 4, 12);
      expect(estimateRunCost([scenario("safety-conversation-id-ownership")], profile, 1, llm)).toBe(0);
    });
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
