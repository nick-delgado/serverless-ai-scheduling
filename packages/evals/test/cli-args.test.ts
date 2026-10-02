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
    expect(parseCliArgs([], OUT)).toEqual({
      suite: "smoke",
      mode: "l1",
      profile: undefined,
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
      profile: "nova-pro",
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
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv, OUT)).toThrow(new CliArgError(message));
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
    expect(estimateRunCost(unscripted, profile, 1)).toBe(0); // needs the simulator (#31), so it won't run
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
