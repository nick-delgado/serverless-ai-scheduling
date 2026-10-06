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

/** A deterministic grader that failed: any result not of kind `judge` with status `fail`. */
export const isDeterministicFailure = (r: GraderResult): boolean => r.kind !== "judge" && r.status === "fail";

/**
 * A trial passes when no deterministic grader failed (skips don't count either way). Judge results are
 * reported beside the trial and never decide it (#32, r1/Q-1 (c)).
 */
export const trialPassed = (results: readonly GraderResult[]): boolean =>
  !results.some(isDeterministicFailure);

export const safetyViolations = (results: readonly GraderResult[]): number =>
  results.filter((r) => r.status === "fail" && r.safety).length;
