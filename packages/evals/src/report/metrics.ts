/**
 * The report's per-run metrics beyond pass@1 (#34): the agent's cost share, the conversation metrics of a
 * scenario run (turns and agent cost per completed conversation), and each run's half of the PRD §7 exit
 * metrics (core-category task success and reliability, its own safety count, its emergency cases).
 *
 * Only type imports from `../suite`, so `suite.ts` can import these without a cycle.
 */
import type { L1TrialResult } from "../l1";
import type { TrialResult } from "../runner";
import { SCENARIO_CATEGORIES } from "../schema";
import type { SimulatorStopReason } from "../simulator/prompt";
import type { CaseResult, Mode } from "../suite";

/** A share as a whole percentage, e.g. `72%`. */
export const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;

/** The nearest-rank percentile, 0 for no values. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

/**
 * The agent's share of a trial's cost: `costUsd` less the simulator's share (PR #97 `8bea70b/SPEC-2` (c)).
 * The judge's cost was never in `costUsd` (#32 r1/Q-2 (a)). L1 trials have no simulator.
 */
export const agentCostUsd = (t: TrialResult | L1TrialResult): number =>
  t.kind === "scenario" ? t.costUsd - t.simulatorCost.costUsd : t.costUsd;

/** The simulator stop reasons that make a conversation completed (ADR-008, amendment 2026-10-03). */
export const COMPLETED_STOP_REASONS: readonly SimulatorStopReason[] = ["goal_achieved", "escalated"];

/** A completed conversation: a scenario trial that ran and ended `goal_achieved` or `escalated` (r1/Q-5). */
export const isCompleted = (t: TrialResult | L1TrialResult): boolean =>
  t.kind === "scenario" &&
  t.status !== "error" &&
  t.status !== "skip" &&
  (COMPLETED_STOP_REASONS as readonly string[]).includes(t.stoppedBecause ?? "");

export interface ConversationMetrics {
  /** Scenario trials that ran (not `skip`), every category. */
  trials: number;
  /** Of those, the completed ones. */
  completed: number;
  /** Turns per completed conversation (r1/A-10); absent with none completed. */
  turns?: { mean: number; p95: number };
  /** The agent's share over every trial that ran, failed and errored ones included. */
  agentCostUsd: number;
  /**
   * `agentCostUsd / completed` (r1/Q-5 (b)): what one completed conversation costs, the conversations that
   * never completed charged to those that did. Absent (n/a) with none completed.
   */
  agentCostPerCompletedUsd?: number;
}

/** Conversation metrics over a scenario run's trials. */
export function conversationMetrics(trials: readonly (TrialResult | L1TrialResult)[]): ConversationMetrics {
  const ran = trials.filter((t) => t.kind === "scenario" && t.status !== "skip");
  const completed = ran.filter(isCompleted);
  const turns = completed.map((t) => (t.kind === "scenario" ? t.turns : 0));
  const agent = ran.reduce((s, t) => s + agentCostUsd(t), 0);
  const turnsMean = mean(turns);
  return {
    trials: ran.length,
    completed: completed.length,
    ...(turnsMean === undefined ? {} : { turns: { mean: turnsMean, p95: percentile(turns, 95) } }),
    agentCostUsd: agent,
    ...(completed.length === 0 ? {} : { agentCostPerCompletedUsd: agent / completed.length }),
  };
}

/** PRD §7's core categories: every scenario category except `safety`. */
export const CORE_CATEGORIES = SCENARIO_CATEGORIES.filter((c) => c !== "safety");

/** The PRD §7 tag for emergency cases (r1/Q-7 (a)). */
export const EMERGENCY_TAG = "emergency";

/** A case left out of the metrics, and why. */
export interface SkippedCase {
  id: string;
  reason: string;
}

/** One core category's task success: the mean pass rate of its runnable cases; absent (n/a) with none. */
export interface CategoryResult {
  category: string;
  cases: number;
  taskSuccess?: number;
}

/** What one run contributes to the PRD §7 exit table (r1/Q-4 (a)). */
export interface ExitHalf {
  mode: Mode;
  trialsPerCase: number;
  /** Scenario mode: mean per-case pass rate over the core cases that ran (an `error` trial is a failure). */
  taskSuccess?: number;
  /** Scenario mode: share of those cases with every trial passing (pass^k; pass^3 in an exit run). */
  reliability?: number;
  /** Scenario mode: task success per core category. */
  byCategory: CategoryResult[];
  safetyViolations: number;
  /** Cases tagged `emergency`, and those of them that passed every trial. */
  emergency: { ids: string[]; passedEvery: string[] };
  /** Cases left out of the denominators, by ID with their reasons. */
  skipped: SkippedCase[];
  /** Cases the budget guard stopped. */
  budgetStopped: string[];
}

/** Why a case was skipped: its own reason, else its first trial's. */
const skipReasonOf = (c: CaseResult): string =>
  c.reason ?? c.trials.find((t) => t.reason !== undefined)?.reason ?? "skipped";

/** The run's half of the §7 exit metrics. */
export function exitHalf(
  mode: Mode,
  trialsPerCase: number,
  cases: readonly CaseResult[],
  safetyViolations: number,
): ExitHalf {
  const ran = cases.filter((c) => c.status !== "skip");
  const core = ran.filter((c) => (CORE_CATEGORIES as readonly string[]).includes(c.category));
  const passRate = (list: readonly CaseResult[]) => mean(list.map((c) => c.passRate));
  const emergency = cases.filter((c) => c.tags.includes(EMERGENCY_TAG));
  const scenario = mode === "scenario";
  const taskSuccess = scenario ? passRate(core) : undefined;
  return {
    mode,
    trialsPerCase,
    ...(taskSuccess === undefined ? {} : { taskSuccess }),
    ...(scenario && core.length > 0
      ? { reliability: core.filter((c) => c.passHatK).length / core.length }
      : {}),
    byCategory: scenario
      ? CORE_CATEGORIES.map((category) => {
          const inCategory = core.filter((c) => c.category === category);
          const value = passRate(inCategory);
          return {
            category,
            cases: inCategory.length,
            ...(value === undefined ? {} : { taskSuccess: value }),
          };
        })
      : [],
    safetyViolations,
    emergency: {
      ids: emergency.map((c) => c.id),
      passedEvery: emergency.filter((c) => c.passHatK).map((c) => c.id),
    },
    skipped: cases.filter((c) => c.status === "skip").map((c) => ({ id: c.id, reason: skipReasonOf(c) })),
    budgetStopped: cases.filter((c) => c.budgetStopped).map((c) => c.id),
  };
}

/** The emergency metric of one half: met only with at least one tagged case, each passing every trial. */
export const emergencyMet = (h: Pick<ExitHalf, "emergency">): boolean =>
  h.emergency.ids.length > 0 && h.emergency.passedEvery.length === h.emergency.ids.length;
