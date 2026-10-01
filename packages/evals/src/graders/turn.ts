/**
 * Turn health (owner decision on PR #71, review finding SPEC-1, option a): the #60 trace fields fail the
 * trial through named, non-safety graders instead of passing unseen.
 * - `trajectory.no_unknown_tools`: the model called a tool it wasn't offered (`ToolCallTrace.known: false`).
 * - `turn.outcome`: a turn ended in `malformed_output`, `context_window_exceeded`, or `iteration_limit`
 *   (the loop then stores a canned fallback reply). These are the agent's behaviour, not the transport's,
 *   so they are failures, not `error` trials.
 * Retried model calls (`LlmCallTrace.attempt > 0`) are a metric on the trial and the run, not a grader.
 */
import type { TurnOutcome } from "@sched/contracts";

import { toolCalls, type TranscriptEvent } from "../transcript";
import { check, type GraderResult } from "./types";

export const FAILED_TURN_OUTCOMES = [
  "malformed_output",
  "context_window_exceeded",
  "iteration_limit",
] as const satisfies TurnOutcome[];

export function gradeTurnHealth(
  events: readonly TranscriptEvent[],
  outcomes: readonly TurnOutcome[],
): GraderResult[] {
  const unknown = toolCalls(events).filter((c) => !c.known);
  const bad = outcomes.flatMap((o, i) =>
    (FAILED_TURN_OUTCOMES as readonly string[]).includes(o) ? [`turn ${i + 1} ended in ${o}`] : [],
  );
  return [
    check(
      "trajectory",
      "trajectory.no_unknown_tools",
      unknown.length === 0 ? undefined : `called unknown tool(s) ${unknown.map((c) => c.name).join(", ")}`,
    ),
    check("turn", "turn.outcome", bad.length === 0 ? undefined : bad.join("; ")),
  ];
}
