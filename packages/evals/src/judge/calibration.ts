/**
 * Judge calibration (#32, ADR-008; r1/Q-3 (b), A-14). Two steps, both `npm run evals` flags:
 *
 * 1. `--export-calibration <results.json>` picks about 20 judged transcripts from a scenario run
 *    (`selectCalibrationTrials`: every rubric dimension covered first, failing trials preferred, then
 *    round-robin by category), and writes them to `packages/evals/calibration/transcripts.json` with an
 *    empty `labels.json` for Nick to fill: a 1–5 score for every rubric dimension each transcript lists.
 *    No model calls.
 * 2. `--calibrate` judges the labelled transcripts with the configured judge profile and reports the
 *    agreement: the share of (transcript, dimension) pairs where judge and human agree on pass/fail
 *    (pass = score ≥ 4), and the exact-score agreement (ADR-008 amendment 2026-10-03). The labels, the
 *    first agreement number and any recalibration are #159.
 */
import { ToolError } from "@sched/contracts";
import { z } from "zod";

import { createTrialEnvironment } from "../environment";
import type { Scenario } from "../schema";
import { trialSystemPrompt } from "../runner";
import { pct } from "../suite";
import type { TranscriptEvent } from "../transcript";
import type { JudgeCost, TrialJudge } from "./judge";
import { addCost, zeroJudgeCost, JudgeError } from "./judge";
import { agentPromptText } from "./prompt";
import { errorReason, issueText } from "../util";
import {
  judgedDimensions,
  JUDGE_RUBRIC_VERSION,
  NEVER_CAME_UP_RULE,
  PASS_SCORE,
  RUBRIC_DIMENSIONS,
  type RubricDimension,
} from "./rubrics";

/** Transcripts an export picks, at most. */
export const CALIBRATION_SIZE = 20;

const Dimension = z.enum(RUBRIC_DIMENSIONS);

/**
 * A transcript event as the calibration files hold it: every field of each `TranscriptEvent` kind, so a
 * malformed event is a usage error naming the field, not `Assistant: undefined` in the judge's prompt
 * (SMELL-205 decision, PR #165). `runCalibration` assigns these events to `TranscriptEvent[]`: a one-way
 * compile-time check that a calibration event is assignable to a `TranscriptEvent`. A new required field
 * on `TranscriptEvent` fails that assignment, but a new optional field or a new event kind doesn't; add
 * either here by hand.
 */
const CalibrationEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("patient"),
    turn: z.number(),
    text: z.string(),
    scriptStep: z.number().optional(),
  }),
  z.object({ kind: z.literal("assistant"), turn: z.number(), text: z.string() }),
  z.object({
    kind: z.literal("tool_call"),
    turn: z.number(),
    id: z.string(),
    name: z.string(),
    known: z.boolean(),
    input: z.unknown(),
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: ToolError.shape.error.optional(),
  }),
]);

/** One exported transcript: what the judge needs, and nothing it mustn't see (no goal, no expectations). */
export const CalibrationTranscript = z.object({
  /** `<scenario id>#<trial>`. */
  id: z.string(),
  scenarioId: z.string(),
  trial: z.int().positive(),
  category: z.string(),
  /** The trial's deterministic status in the source run. */
  status: z.enum(["pass", "fail"]),
  dimensions: z.array(Dimension).min(1),
  /** The agent's system prompt for this trial, rebuilt at export (the judge sees it for disclosure). */
  agentSystemPrompt: z.string(),
  events: z.array(CalibrationEvent),
});
export type CalibrationTranscript = z.infer<typeof CalibrationTranscript>;

export const CalibrationSet = z.object({
  rubricVersion: z.string(),
  /** The results file the transcripts came from, and its prompt version. */
  source: z.object({ file: z.string(), promptVersion: z.string(), profile: z.string() }),
  transcripts: z.array(CalibrationTranscript),
});
export type CalibrationSet = z.infer<typeof CalibrationSet>;

const Score = z.int().min(1).max(5);

/** Nick's labels: per transcript, a 1–5 score (or `null`, not labelled yet) for each dimension it lists. */
export const LabelsFile = z.object({
  rubricVersion: z.string(),
  instructions: z.string().optional(),
  labels: z.array(z.object({ id: z.string(), scores: z.partialRecord(Dimension, Score.nullable()) })),
});
export type LabelsFile = z.infer<typeof LabelsFile>;

/** The part of a results file (`RunReport`) an export reads. */
const ExportSource = z.object({
  mode: z.literal("scenario"),
  profile: z.string(),
  promptVersion: z.string(),
  cases: z.array(
    z.object({
      id: z.string(),
      trials: z.array(
        z.looseObject({
          kind: z.literal("scenario"),
          trial: z.int().positive(),
          status: z.string(),
          events: z.array(CalibrationEvent),
        }),
      ),
    }),
  ),
});

/** What selection needs to know about a trial. */
export interface SelectionCandidate {
  scenario: Pick<Scenario, "id" | "category">;
  trial: number;
  /** Any status; selection only picks `pass` and `fail`. */
  status: string;
  /** The rubric dimensions the trial's scenario lists. */
  dimensions: readonly RubricDimension[];
}

/** How many transcripts each rubric dimension should appear in, when the run has that many. */
export const CALIBRATION_MIN_PER_DIMENSION = 2;

/**
 * Pick up to `size` pass or fail trials (SPEC-1 decision, PR #165), deterministically:
 * 1. Cover the dimensions: rarest dimension first, keep picking trials that list it until it appears in
 *    `CALIBRATION_MIN_PER_DIMENSION` picked transcripts, or in every candidate that lists it when fewer
 *    exist. Failing trials come first, then first trials before repeats, then by scenario id.
 * 2. Fill the remaining slots round-robin by category (categories in name order), each category's
 *    trials in the same order: failing first, then first trials, then by scenario id.
 */
export function selectCalibrationTrials<T extends SelectionCandidate>(
  candidates: readonly T[],
  size = CALIBRATION_SIZE,
): (T & { status: "pass" | "fail" })[] {
  type Picked = T & { status: "pass" | "fail" };
  const order = (a: Picked, b: Picked) =>
    Number(b.status === "fail") - Number(a.status === "fail") ||
    a.trial - b.trial ||
    a.scenario.id.localeCompare(b.scenario.id);
  const eligible = candidates
    .filter((c): c is Picked => c.status === "pass" || c.status === "fail")
    .sort(order);
  const picked: Picked[] = [];
  const pick = (c: Picked) => {
    if (picked.length < size && !picked.includes(c)) picked.push(c);
  };

  const listing = (d: RubricDimension) => eligible.filter((c) => c.dimensions.includes(d));
  const rarestFirst = [...RUBRIC_DIMENSIONS].sort((a, b) => listing(a).length - listing(b).length);
  for (const d of rarestFirst)
    for (const c of listing(d)) {
      // Fewer candidates than the minimum: the loop ends with every one of them picked.
      if (picked.filter((p) => p.dimensions.includes(d)).length >= CALIBRATION_MIN_PER_DIMENSION) break;
      pick(c);
    }

  const lanes = [...new Set(eligible.map((c) => c.scenario.category))]
    .sort()
    .map((category) => eligible.filter((c) => c.scenario.category === category && !picked.includes(c)));
  for (let i = 0; lanes.some((lane) => i < lane.length); i++)
    for (const lane of lanes) {
      const c = lane[i];
      if (c !== undefined) pick(c);
    }
  return picked;
}

/**
 * Build the calibration set and an empty labels file from a parsed results file. Only scenario trials
 * that passed or failed and list at least one rubric dimension are candidates. The agent's system prompt
 * is rebuilt with the production prompt, so the results file must come from that prompt version.
 */
export async function exportCalibration(
  report: unknown,
  scenarios: readonly Scenario[],
  sourceFile: string,
  size = CALIBRATION_SIZE,
): Promise<{ set: CalibrationSet; labels: LabelsFile }> {
  const parsed = ExportSource.safeParse(report);
  if (!parsed.success) {
    throw new Error(`not a scenario results file: ${parsed.error.issues.map(issueText).join("; ")}`);
  }
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const candidates = parsed.data.cases.flatMap((c) => {
    const scenario = byId.get(c.id);
    const dimensions = scenario === undefined ? [] : judgedDimensions(scenario);
    if (scenario === undefined || dimensions.length === 0) return [];
    return c.trials.flatMap((t) =>
      t.events.length > 0
        ? [{ scenario, trial: t.trial, status: t.status, dimensions, events: t.events }]
        : [],
    );
  });

  const transcripts: CalibrationTranscript[] = [];
  for (const c of selectCalibrationTrials(candidates, size)) {
    const env = await createTrialEnvironment(c.scenario, { trial: c.trial });
    const prompt = trialSystemPrompt(env);
    if (prompt.version !== parsed.data.promptVersion)
      throw new Error(
        `the results file ran prompt ${parsed.data.promptVersion}, but the export rebuilds ${prompt.version}`,
      );
    transcripts.push({
      id: `${c.scenario.id}#${String(c.trial)}`,
      scenarioId: c.scenario.id,
      trial: c.trial,
      category: c.scenario.category,
      status: c.status,
      dimensions: [...c.dimensions],
      agentSystemPrompt: agentPromptText(prompt),
      events: c.events,
    });
  }
  return {
    set: {
      rubricVersion: JUDGE_RUBRIC_VERSION,
      source: { file: sourceFile, promptVersion: parsed.data.promptVersion, profile: parsed.data.profile },
      transcripts,
    },
    labels: emptyLabels(transcripts),
  };
}

/**
 * What the labels file tells the human labeller. It states the judge prompt's "never came up → 5" rule
 * (`NEVER_CAME_UP_RULE`), so both raters score against the same rubric (SPEC-4 decision, PR #165).
 */
export const LABEL_INSTRUCTIONS = `Read each transcript in transcripts.json and replace each null with a 1-5 score against the rubric in packages/evals/src/judge/rubrics.ts (${JUDGE_RUBRIC_VERSION}). ${NEVER_CAME_UP_RULE}, as the judge does; a situation that only partly came up (a patient mentions a symptom but asks nothing) is scored on its anchors. Leave null what you don't want to label.`;

/** A labels file with every score `null`, for each transcript's dimensions. */
export function emptyLabels(
  transcripts: readonly Pick<CalibrationTranscript, "id" | "dimensions">[],
): LabelsFile {
  return {
    rubricVersion: JUDGE_RUBRIC_VERSION,
    instructions: LABEL_INSTRUCTIONS,
    labels: transcripts.map((t) => ({
      id: t.id,
      scores: Object.fromEntries(t.dimensions.map((d) => [d, null])),
    })),
  };
}

/** Whether a labels file holds any human score (an export must not overwrite one that does). */
export const hasLabels = (labels: LabelsFile): boolean =>
  labels.labels.some((l) => Object.values(l.scores).some((s) => typeof s === "number"));

/** One (transcript, dimension) pair with both a human and a judge score. */
export interface ScorePair {
  id: string;
  dimension: RubricDimension;
  human: number;
  judge: number;
}

export interface AgreementStats {
  pairs: number;
  /** Share of pairs where judge and human agree on pass/fail (pass = score ≥ 4); `null` with no pairs. */
  passFail: number | null;
  /** Share of pairs with the same score; `null` with no pairs. */
  exact: number | null;
}

export interface Agreement extends AgreementStats {
  perDimension: Partial<Record<RubricDimension, AgreementStats>>;
  /** Pairs where judge and human disagree on pass/fail. */
  disagreements: ScorePair[];
}

function stats(pairs: readonly ScorePair[]): AgreementStats {
  const share = (agree: (p: ScorePair) => boolean) =>
    pairs.length === 0 ? null : pairs.filter(agree).length / pairs.length;
  return {
    pairs: pairs.length,
    passFail: share((p) => p.human >= PASS_SCORE === p.judge >= PASS_SCORE),
    exact: share((p) => p.human === p.judge),
  };
}

/** Agreement over the pairs, overall and per dimension. */
export function computeAgreement(pairs: readonly ScorePair[]): Agreement {
  const perDimension: Agreement["perDimension"] = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const own = pairs.filter((p) => p.dimension === d);
    if (own.length > 0) perDimension[d] = stats(own);
  }
  return {
    ...stats(pairs),
    perDimension,
    disagreements: pairs.filter((p) => p.human >= PASS_SCORE !== p.judge >= PASS_SCORE),
  };
}

/** The human scores of one transcript: only the ones filled in, for dimensions the transcript lists. */
export const labelledDimensions = (
  labels: LabelsFile,
  transcript: Pick<CalibrationTranscript, "id" | "dimensions">,
): [RubricDimension, number][] =>
  transcript.dimensions.flatMap((d) => {
    const s = labels.labels.find((l) => l.id === transcript.id)?.scores[d];
    return typeof s === "number" ? [[d, s] as [RubricDimension, number]] : [];
  });

export interface CalibrationReport {
  rubricVersion: string;
  judge: string;
  judgedAt: string;
  /** Transcripts with at least one human label, and so judged. */
  transcripts: number;
  /** Transcripts the judge gave no verdict for, with why. */
  judgeErrors: { id: string; error: string }[];
  costUsd: number;
  agreement: Agreement;
}

/**
 * Judge every transcript that has at least one human label, on the dimensions labelled, and compute the
 * agreement. A judge error leaves that transcript's pairs out and is listed.
 */
export async function runCalibration(
  set: CalibrationSet,
  labels: LabelsFile,
  judge: TrialJudge,
  now: () => Date = () => new Date(),
): Promise<CalibrationReport> {
  const pairs: ScorePair[] = [];
  const judgeErrors: CalibrationReport["judgeErrors"] = [];
  const cost: JudgeCost = zeroJudgeCost();
  let judged = 0;
  for (const t of set.transcripts) {
    const human = labelledDimensions(labels, t);
    if (human.length === 0) continue;
    judged += 1;
    // Compile-time check (SMELL-205): a calibration event is a `TranscriptEvent`.
    const events: readonly TranscriptEvent[] = t.events;
    try {
      const verdict = await judge.judge({
        dimensions: human.map(([d]) => d),
        events,
        agentSystemPrompt: t.agentSystemPrompt,
      });
      addCost(cost, verdict.cost);
      for (const [dimension, score] of human) {
        const j = verdict.scores.find((s) => s.dimension === dimension);
        if (j !== undefined) pairs.push({ id: t.id, dimension, human: score, judge: j.score });
      }
    } catch (error) {
      if (error instanceof JudgeError) addCost(cost, error.cost);
      judgeErrors.push({ id: t.id, error: errorReason(error) });
    }
  }
  return {
    rubricVersion: set.rubricVersion,
    judge: judge.name,
    judgedAt: now().toISOString(),
    transcripts: judged,
    judgeErrors,
    costUsd: cost.costUsd,
    agreement: computeAgreement(pairs),
  };
}

const share = (x: number | null) => (x === null ? "–" : pct(x));

/** The calibration report as markdown, for the terminal and the `.md` next to the JSON. */
export function calibrationMarkdown(report: CalibrationReport): string {
  const a = report.agreement;
  return [
    `# Judge calibration: ${report.judge}`,
    "",
    `- ${report.transcripts} labelled transcript(s), ${a.pairs} (transcript, dimension) pair(s), ${report.judgeErrors.length} judge error(s), cost $${report.costUsd.toFixed(4)}`,
    `- Pass/fail agreement (pass = score ≥ ${PASS_SCORE}): **${share(a.passFail)}** (PRD §7 target ≥ 80%) · exact-score agreement ${share(a.exact)}`,
    "",
    "| Dimension | Pairs | Pass/fail | Exact |",
    "|---|---|---|---|",
    ...Object.entries(a.perDimension).map(
      ([d, s]) => `| ${d} | ${s.pairs} | ${share(s.passFail)} | ${share(s.exact)} |`,
    ),
    ...(a.disagreements.length === 0
      ? []
      : [
          "",
          "Pass/fail disagreements:",
          ...a.disagreements.map((p) => `- ${p.id} ${p.dimension}: human ${p.human}, judge ${p.judge}`),
        ]),
    ...(report.judgeErrors.length === 0
      ? []
      : ["", "Judge errors:", ...report.judgeErrors.map((e) => `- ${e.id}: ${e.error}`)]),
  ].join("\n");
}
