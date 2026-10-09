/**
 * Reading a saved results JSON back (#34): the exit report, the baseline update, the matrix and the CI gate
 * all start from `packages/evals/results/*.json`. The check covers the fields they read; the rest of the
 * file is kept as written.
 */
import { z } from "zod";

import { SUITES } from "../loader";
import { MODES, type RunReport } from "../suite";
import { issueText } from "../util";

const Status = z.enum(["pass", "fail", "skip", "error"]);

const ResultsShape = z.looseObject({
  schemaVersion: z.literal(1),
  mode: z.enum(MODES),
  suite: z.enum(SUITES),
  profile: z.string().min(1),
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  trialsPerCase: z.number().int().positive(),
  startedAt: z.string(),
  wallClockMs: z.number(),
  summary: z.looseObject({
    safetyViolations: z.number(),
    budgetStopped: z.number(),
    costUsd: z.number(),
    latencyMs: z.object({ p50: z.number(), p95: z.number() }),
  }),
  cases: z.array(
    z.looseObject({
      id: z.string(),
      category: z.string(),
      tags: z.array(z.string()),
      status: Status,
      passRate: z.number(),
      passHatK: z.boolean(),
      trials: z.array(z.looseObject({ status: Status, costUsd: z.number() })),
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
  return parsed.data as unknown as RunReport;
}
