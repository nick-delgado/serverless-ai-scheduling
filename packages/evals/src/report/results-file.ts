/**
 * Reading a saved results JSON back (#34): `--exit-report`, `--update-baseline` and the CI gate
 * (`scripts/eval-gate.ts`) start from `packages/evals/results/*.json`. The schema checks the fields the exit
 * table, the baseline and the gate's verdict read from a report (the run's identity, the summary's counts,
 * costs and latency, each case's status and rates, and each trial's status, cost, safety count and graders,
 * plus a scenario trial's turns and simulator and judge costs, which the exit table's conversation metrics
 * use). The rest of the file (transcripts, usage, simulator turns) is kept as written, unchecked, and the result
 * is typed as a `RunReport` on that basis.
 */
import { z } from "zod";

import { SUITES } from "../loader";
import { MODES, type CaseStatus, type RunReport } from "../suite";
import { issueText } from "../util";

/** Every case and trial status, one key each: widening `TrialStatus` fails typecheck here until it's added. */
const STATUS_KEYS: Record<CaseStatus, true> = { pass: true, fail: true, skip: true, error: true };

/** A case or trial status, as results files and baselines hold it. */
export const CaseStatusSchema = z.enum(Object.keys(STATUS_KEYS) as [CaseStatus, ...CaseStatus[]]);

const Cost = z.looseObject({ costUsd: z.number() });

const Grader = z.looseObject({
  kind: z.string(),
  name: z.string(),
  status: z.string(),
  score: z.number().optional(),
});

const TrialCommon = {
  trial: z.number().int().positive(),
  status: CaseStatusSchema,
  reason: z.string().optional(),
  costUsd: z.number(),
  safetyViolations: z.number(),
  graders: z.array(Grader),
};

const Trial = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("scenario"),
    ...TrialCommon,
    turns: z.number(),
    stoppedBecause: z.string().optional(),
    simulatorCost: Cost,
    judgeCost: Cost,
    turnDurationsMs: z.array(z.number()),
  }),
  z.looseObject({ kind: z.literal("l1"), ...TrialCommon }),
]);

const ResultsShape = z.looseObject({
  schemaVersion: z.literal(1),
  mode: z.enum(MODES),
  suite: z.enum(SUITES),
  profile: z.string().min(1),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  trialsPerCase: z.number().int().positive(),
  simulator: z.string().optional(),
  startedAt: z.string(),
  wallClockMs: z.number(),
  summary: z.looseObject({
    passed: z.number(),
    safetyViolations: z.number(),
    budgetStopped: z.number(),
    costUsd: z.number(),
    toolCallAccuracy: z.number().optional(),
    latencyMs: z.object({ p50: z.number(), p95: z.number() }),
    judge: z.looseObject({ costUsd: z.number(), rubricAverage: z.number().optional() }).optional(),
  }),
  cases: z.array(
    z.looseObject({
      id: z.string(),
      category: z.string(),
      tags: z.array(z.string()),
      status: CaseStatusSchema,
      passRate: z.number(),
      passHatK: z.boolean(),
      budgetStopped: z.literal(true).optional(),
      reason: z.string().optional(),
      trials: z.array(Trial),
    }),
  ),
});

/** A results file's parsed JSON as a `RunReport`; throws an `Error` naming `path` and the bad fields. */
export function parseRunReport(value: unknown, path: string): RunReport {
  const parsed = ResultsShape.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `${path} isn't an eval results file: ${parsed.error.issues.slice(0, 5).map(issueText).join("; ")}`,
    );
  // The unchecked fields are kept as written (see the header).
  return parsed.data as unknown as RunReport;
}
