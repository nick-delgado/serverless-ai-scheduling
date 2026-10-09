/**
 * Committed baselines (#34, ADR-008 amendment 2026-10-09): `packages/evals/baselines/<profile>.json` holds the
 * smoke suite at k=1 in each mode: each case's status, and the run's model ID, prompt version, date, passed
 * count, safety violations and agent-share cost (r1/A-1). `npm run evals -- --update-baseline <a.json> <b.json>`
 * promotes two saved results files to it, with no model call (r1/A-2).
 *
 * The CI gate's comparison (r1/Q-1 (a)), per case and per mode: a mode fails when more than one case that
 * passed in that mode's baseline doesn't pass now. A case that was `skip` in the baseline, or that is
 * missing now, or that is new since, is listed and not counted. A different model ID or prompt version is
 * a warning; the comparison still runs.
 */
import { join } from "node:path";

import { z } from "zod";

import type { CaseStatus, Mode, RunReport } from "../suite";
import { issueText } from "../util";
import { agentCostUsd } from "./metrics";

const Status = z.enum(["pass", "fail", "skip", "error"]);

export const BaselineMode = z.object({
  modelId: z.string().min(1),
  promptVersion: z.string().min(1),
  /** The run's `startedAt`. */
  recordedAt: z.string(),
  cases: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  safetyViolations: z.number().int().nonnegative(),
  /** The agent's share of the run's cost (PR #97 `8bea70b/SPEC-2` (c)). */
  agentCostUsd: z.number().nonnegative(),
  /** Each case's status, by ID. An object, not an array, so Prettier leaves the file as written. */
  statuses: z.record(z.string(), Status),
});
export type BaselineMode = z.infer<typeof BaselineMode>;

export const Baseline = z.object({
  schemaVersion: z.literal(1),
  profile: z.string().min(1),
  suite: z.literal("smoke"),
  trialsPerCase: z.literal(1),
  modes: z.object({ l1: BaselineMode, scenario: BaselineMode }),
});
export type Baseline = z.infer<typeof Baseline>;

/** Regressions a mode tolerates (FR-041: "more than one case below the committed baseline" fails). */
export const MAX_REGRESSIONS_PER_MODE = 1;

/** `<dir>/<profile>.json`. */
export const baselinePath = (dir: string, profile: string): string => join(dir, `${profile}.json`);

/** The file's text: 2-space JSON and a trailing newline, as Prettier writes it. */
export const baselineJson = (b: Baseline): string => `${JSON.stringify(b, null, 2)}\n`;

/** A baseline file's parsed JSON, validated; throws an `Error` naming `path`. */
export function parseBaseline(value: unknown, path: string): Baseline {
  const parsed = Baseline.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(`${path} isn't a baseline: ${parsed.error.issues.slice(0, 5).map(issueText).join("; ")}`);
}

const modeOf = (r: RunReport): BaselineMode => ({
  modelId: r.modelId,
  promptVersion: r.promptVersion,
  recordedAt: r.startedAt,
  cases: r.cases.length,
  passed: r.summary.passed,
  safetyViolations: r.summary.safetyViolations,
  // To a millionth of a dollar, so float noise doesn't churn the committed file.
  agentCostUsd:
    Math.round(r.cases.flatMap((c) => c.trials).reduce((s, t) => s + agentCostUsd(t), 0) * 1e6) / 1e6,
  statuses: Object.fromEntries(r.cases.map((c) => [c.id, c.status])),
});

/**
 * A baseline from one L1 and one scenario results file, identified by `mode`. It refuses (throws) files
 * that aren't the smoke suite at k=1, two of one mode, different profiles, or a budget-stopped case (r1/A-2).
 */
export function baselineFromReports(reports: readonly RunReport[]): Baseline {
  const l1 = reports.filter((r) => r.mode === "l1");
  const scenario = reports.filter((r) => r.mode === "scenario");
  const problems: string[] = [];
  if (reports.length !== 2 || l1.length !== 1 || scenario.length !== 1)
    problems.push(`need one l1 and one scenario results file, got ${reports.map((r) => r.mode).join(", ")}`);
  for (const r of reports) {
    if (r.suite !== "smoke") problems.push(`${r.mode}: suite ${r.suite}, not smoke`);
    if (r.trialsPerCase !== 1) problems.push(`${r.mode}: ${r.trialsPerCase} trials per case, not 1`);
    if (r.summary.budgetStopped > 0)
      problems.push(`${r.mode}: the budget guard stopped ${r.summary.budgetStopped} case(s)`);
  }
  const profiles = [...new Set(reports.map((r) => r.profile))];
  if (profiles.length > 1) problems.push(`profiles differ: ${profiles.join(", ")}`);
  const [l1Report] = l1;
  const [scenarioReport] = scenario;
  if (problems.length > 0 || l1Report === undefined || scenarioReport === undefined)
    throw new Error(`not a baseline: ${problems.join("; ")}`);
  return {
    schemaVersion: 1,
    profile: l1Report.profile,
    suite: "smoke",
    trialsPerCase: 1,
    modes: { l1: modeOf(l1Report), scenario: modeOf(scenarioReport) },
  };
}

/** One case in a mode's comparison. */
export interface CaseComparison {
  id: string;
  baseline?: CaseStatus;
  now?: CaseStatus;
  /** Counted: passed in the baseline and doesn't pass now. */
  regressed: boolean;
  /** Listed, not counted: skipped in the baseline, missing now, or new since. */
  note?: string;
}

export interface ModeComparison {
  mode: Mode;
  rows: CaseComparison[];
  regressions: string[];
  /** More than `MAX_REGRESSIONS_PER_MODE` regressions. */
  failed: boolean;
  /** A different model ID or prompt version than the baseline's. */
  warnings: string[];
}

/** A mode's statuses now against its baseline (r1/Q-1 (a)). */
export function compareMode(
  mode: Mode,
  base: BaselineMode,
  now: { modelId: string; promptVersion: string; statuses: Readonly<Record<string, CaseStatus>> },
): ModeComparison {
  const ids = [...new Set([...Object.keys(base.statuses), ...Object.keys(now.statuses)])].sort();
  const rows = ids.map((id): CaseComparison => {
    const b = base.statuses[id];
    const n = now.statuses[id];
    const row = { id, ...(b === undefined ? {} : { baseline: b }), ...(n === undefined ? {} : { now: n }) };
    if (b === undefined) return { ...row, regressed: false, note: "new since the baseline; not counted" };
    if (n === undefined) return { ...row, regressed: false, note: "not in this run; not counted" };
    if (b === "skip") return { ...row, regressed: false, note: "skipped in the baseline; not counted" };
    return { ...row, regressed: b === "pass" && n !== "pass" };
  });
  const regressions = rows.filter((r) => r.regressed).map((r) => r.id);
  const warnings = [
    ...(now.modelId === base.modelId ? [] : [`model ID ${now.modelId}, baseline ${base.modelId}`]),
    ...(now.promptVersion === base.promptVersion
      ? []
      : [`prompt version ${now.promptVersion}, baseline ${base.promptVersion}`]),
  ];
  return { mode, rows, regressions, failed: regressions.length > MAX_REGRESSIONS_PER_MODE, warnings };
}
