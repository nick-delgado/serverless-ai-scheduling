/**
 * The judge's grader results for one trial (#32). Every `judge:` entry and judged invariant a scenario
 * lists gets one `judge.<dimension>` result (kind `judge`, never a safety check, r1/A-2):
 * - a rubric dimension the judge scored: `pass` at `PASS_SCORE` or above, else `fail`, with the score
 *   and evidence quotes;
 * - a rubric dimension it couldn't score: `skip`, saying why (judge off, the trial errored, or the
 *   judge's error, r1/A-9);
 * - `no_hallucinated_slots`: `skip`, pointing at the deterministic grader (r1/A-5);
 * - a dimension without a rubric: `skip` (AC 2).
 *
 * These results never change a trial's status (r1/Q-1 (c)): `trialPassed` ignores kind `judge`.
 */
import { errorReason } from "../util";
import type { GraderResult } from "../graders/types";
import type { Scenario } from "../schema";
import type { TranscriptEvent } from "../transcript";
import { JudgeError, zeroJudgeCost, type JudgeCost, type TrialJudge } from "./judge";
import {
  DETERMINISTIC_JUDGE_DIMENSIONS,
  judgedDimensions,
  PASS_SCORE,
  unrubricedDimensions,
} from "./rubrics";

export const JUDGE_OFF = "LLM judge off (--no-judge)";
export const NOT_JUDGED_ERRORED = "not judged: the trial errored";
export const NO_RUBRIC = "no rubric for this dimension yet (#32 covers tone, clarity and six invariants)";

export interface JudgeGrading {
  graders: GraderResult[];
  cost: JudgeCost;
  /** Why the judge produced no verdict, when it was asked for one. */
  error?: string;
}

export interface JudgeGradingInput {
  scenario: Pick<Scenario, "expect">;
  events: readonly TranscriptEvent[];
  agentSystemPrompt: string;
  /** Undefined: the judge is off. */
  judge: TrialJudge | undefined;
  /** An errored trial isn't judged (r1/A-6). */
  trialErrored: boolean;
}

const skipped = (name: string, detail: string): GraderResult => ({
  kind: "judge",
  name,
  status: "skip",
  safety: false,
  detail,
});

export async function gradeWithJudge(input: JudgeGradingInput): Promise<JudgeGrading> {
  const dimensions = judgedDimensions(input.scenario);
  const others: GraderResult[] = [
    ...DETERMINISTIC_JUDGE_DIMENSIONS.filter((d) => input.scenario.expect.judge.includes(d)).map((d) =>
      skipped(`judge.${d}`, `graded deterministically: invariant.${d}`),
    ),
    ...unrubricedDimensions(input.scenario).map((d) => skipped(`judge.${d}`, NO_RUBRIC)),
  ];
  const cost = zeroJudgeCost();
  const allSkipped = (why: string) => [...dimensions.map((d) => skipped(`judge.${d}`, why)), ...others];
  if (dimensions.length === 0) return { graders: others, cost };
  if (input.judge === undefined) return { graders: allSkipped(JUDGE_OFF), cost };
  if (input.trialErrored) return { graders: allSkipped(NOT_JUDGED_ERRORED), cost };

  try {
    const verdict = await input.judge.judge({
      dimensions,
      events: input.events,
      agentSystemPrompt: input.agentSystemPrompt,
    });
    const byDimension = new Map(verdict.scores.map((s) => [s.dimension, s]));
    const graders = dimensions.map((d): GraderResult => {
      const s = byDimension.get(d);
      if (s === undefined) return skipped(`judge.${d}`, "the judge returned no score");
      return {
        kind: "judge",
        name: `judge.${d}`,
        status: s.score >= PASS_SCORE ? "pass" : "fail",
        safety: false,
        score: s.score,
        evidence: s.evidence,
        detail: `${s.score}/5: ${s.reason}`,
      };
    });
    return { graders: [...graders, ...others], cost: verdict.cost };
  } catch (error) {
    const reason = `judge error: ${errorReason(error)}`;
    return {
      graders: allSkipped(reason),
      cost: error instanceof JudgeError ? error.cost : cost,
      error: reason,
    };
  }
}
