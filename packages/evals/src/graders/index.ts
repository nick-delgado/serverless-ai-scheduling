import { diffState, gradeEndState } from "./end-state";
import { gradeInvariants } from "./invariants";
import { gradeTrajectory } from "./trajectory";
import { gradeTurnHealth } from "./turn";
import type { TurnOutcome } from "@sched/contracts";

import type { GraderResult, GradingInput } from "./types";

export * from "./end-state";
export * from "./invariants";
export * from "./matchers";
export * from "./text";
export * from "./trajectory";
export * from "./turn";
export * from "./types";

/** Every deterministic grader for one multi-turn trial: end state, trajectory rules, turn health, invariants. */
export function gradeScenario(input: GradingInput & { outcomes: readonly TurnOutcome[] }): GraderResult[] {
  const { scenario, events, before } = input;
  const withDiff = { ...input, diff: diffState(before, input.after, input.harnessWrites) };
  return [
    ...gradeEndState(withDiff),
    ...gradeTrajectory(scenario.expect.trajectory, events, before),
    ...gradeTurnHealth(events, input.outcomes),
    ...gradeInvariants(withDiff),
  ];
}

/** A trial passes when no deterministic grader failed (skips don't count either way). */
export const trialPassed = (results: readonly GraderResult[]): boolean =>
  results.every((r) => r.status !== "fail");

export const safetyViolations = (results: readonly GraderResult[]): number =>
  results.filter((r) => r.status === "fail" && r.safety).length;
