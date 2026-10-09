/**
 * Synthetic run reports for the report, baseline, matrix and gate tests (#34): only the fields those read,
 * built through `summarize` so the summary matches the cases.
 */
import type { GraderResult } from "../src/graders";
import type { L1TrialResult } from "../src/l1";
import type { TrialResult, TrialStatus } from "../src/runner";
import { summarize, type CaseResult, type Mode, type RunReport } from "../src/suite";
import { zeroJudgeCost, zeroSimulatorCost } from "../src";

export interface FakeTrial {
  status: TrialStatus;
  stoppedBecause?: string;
  turns?: number;
  costUsd?: number;
  simulatorCostUsd?: number;
  safetyViolations?: number;
  reason?: string;
  graders?: GraderResult[];
  turnDurationsMs?: number[];
}

export function scenarioTrial(t: FakeTrial, trial = 1): TrialResult {
  return {
    kind: "scenario",
    trial,
    status: t.status,
    ...(t.reason === undefined ? {} : { reason: t.reason }),
    graders: t.graders ?? [],
    safetyViolations: t.safetyViolations ?? 0,
    events: [],
    turns: t.turns ?? 2,
    outcomes: [],
    ...(t.stoppedBecause === undefined ? {} : { stoppedBecause: t.stoppedBecause }),
    simulator: "llm:sonnet-4.6:sim.v1",
    simulatorTurns: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    llmCalls: 1,
    llmRetries: 0,
    costUsd: t.costUsd ?? 0,
    simulatorCost: { ...zeroSimulatorCost(), costUsd: t.simulatorCostUsd ?? 0 },
    judgeCost: zeroJudgeCost(),
    durationMs: 10,
    turnDurationsMs: t.turnDurationsMs ?? [100],
  };
}

export function l1Trial(t: FakeTrial, trial = 1): L1TrialResult {
  return {
    kind: "l1",
    trial,
    status: t.status === "skip" ? "error" : t.status,
    ...(t.reason === undefined ? {} : { reason: t.reason }),
    graders: t.graders ?? [],
    safetyViolations: t.safetyViolations ?? 0,
    costUsd: t.costUsd ?? 0,
    durationMs: 10,
  };
}

export interface FakeCase {
  id: string;
  category?: string;
  tags?: string[];
  trials: FakeTrial[];
  /** Trials the case should have had (default: `trials.length`); fewer ran means not pass^k. */
  k?: number;
  budgetStopped?: true;
  reason?: string;
}

function caseOf(mode: Mode, c: FakeCase): CaseResult {
  const trials = c.trials.map((t, i) => (mode === "l1" ? l1Trial(t, i + 1) : scenarioTrial(t, i + 1)));
  const ran = trials.filter((t) => t.status !== "skip");
  const passed = ran.filter((t) => t.status === "pass").length;
  const status =
    trials.length === 0 || trials.every((t) => t.status === "skip")
      ? "skip"
      : trials.some((t) => t.status === "error")
        ? "error"
        : passed === trials.length
          ? "pass"
          : "fail";
  return {
    id: c.id,
    category: c.category ?? (mode === "l1" ? "l1" : "book"),
    tags: c.tags ?? [],
    status,
    passRate: ran.length === 0 ? 0 : passed / ran.length,
    passHatK: ran.length === (c.k ?? c.trials.length) && passed === ran.length && ran.length > 0,
    ...(c.budgetStopped ? { budgetStopped: true as const } : {}),
    ...(c.reason === undefined ? {} : { reason: c.reason }),
    trials,
  };
}

export function fakeReport(
  mode: Mode,
  cases: FakeCase[],
  extra: Partial<Omit<RunReport, "cases" | "summary" | "mode">> = {},
): RunReport {
  const results = cases.map((c) => caseOf(mode, c));
  return {
    schemaVersion: 1,
    mode,
    suite: "smoke",
    profile: "sonnet-4.6",
    modelId: "us.anthropic.claude-sonnet-4-6",
    promptVersion: "system.v1",
    pricesAsOf: "2026-09-29",
    trialsPerCase: 1,
    ...(mode === "scenario" ? { simulator: "llm:sonnet-4.6:sim.v1" } : {}),
    llm: "scripted",
    startedAt: "2026-10-09T12:00:00.000Z",
    finishedAt: "2026-10-09T12:05:00.000Z",
    wallClockMs: 300_000,
    ...extra,
    summary: summarize(mode, results),
    cases: results,
  };
}

/** `n` passing cases `<prefix>-1` … `<prefix>-n`. */
export const passing = (prefix: string, n: number, extra: Partial<FakeCase> = {}): FakeCase[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    trials: [{ status: "pass" as const }],
    ...extra,
  }));
