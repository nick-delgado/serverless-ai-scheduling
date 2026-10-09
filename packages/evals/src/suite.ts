/**
 * Runs a suite (many cases × k trials) and aggregates the ADR-008 metrics: pass@1, pass^k, safety
 * violations, L1 tool-call accuracy, latency, cost, and wall-clock. In scenario mode it also reports the
 * LLM judge's scores beside them (#32): they never change a case's status. Since #34 a scenario run also
 * reports turns and agent cost per completed conversation, each run its half of the PRD §7 exit metrics
 * (core-category task success and reliability, its emergency cases), and the markdown a per-scenario
 * drill-down (`report/`).
 */
import { PRICES_AS_OF, type LlmClient, type ModelProfile } from "@sched/agent";
import type { ToolRegistry } from "@sched/tools";

import { isDeterministicFailure, type GraderResult } from "./graders";
import type { TrialJudge } from "./judge/judge";
import {
  JUDGE_RUBRIC_VERSION,
  PASS_SCORE,
  RUBRIC_DIMENSIONS,
  unrubricedInUse,
  type RubricDimension,
} from "./judge/rubrics";
import { L1_ACTION, runL1Trial, type L1TrialResult } from "./l1";
import type { Suite } from "./loader";
import type { RateLimitStats } from "./rate-limit";
import { conversationLine, drillDown, exitHalfLines } from "./report/markdown";
import { conversationMetrics, mean, pct, percentile, type ConversationMetrics } from "./report/metrics";
import { isL1Case, type L1Case, type Scenario } from "./schema";
import { runScenarioTrial, type TrialResult, type TrialStatus } from "./runner";
import { scriptOnlySimulator, type PatientSimulator } from "./simulator";
import { promptFor, type SystemPromptFactory } from "./system-prompt";

export const MODES = ["l1", "scenario"] as const;
export type Mode = (typeof MODES)[number];
export type CaseStatus = TrialStatus;

export interface CaseResult {
  id: string;
  category: string;
  tags: string[];
  status: CaseStatus;
  /** Passed trials / trials run. */
  passRate: number;
  /** All k trials passed (pass^k). */
  passHatK: boolean;
  /** The `--max-cost` guard stopped this case before all its trials ran (TEST-105 decision, PR #71). */
  budgetStopped?: true;
  /** Why the case didn't run all its trials (the budget guard). */
  reason?: string;
  trials: (TrialResult | L1TrialResult)[];
}

/** The LLM judge's part of a scenario run (#32, r1/A-12). Reported beside pass@1, never inside it. */
export interface JudgeSummary {
  /** The judge's calls, outside `RunSummary.costUsd` (r1/Q-2 (a)). */
  costUsd: number;
  /** Trials with at least one score. */
  judgedTrials: number;
  /** `judge.*` results below the pass score, over every trial. */
  fails: number;
  /** Trials the judge gave no verdict for (`TrialResult.judgeError`). */
  errors: number;
  /** Mean score per rubric dimension that was scored. */
  meanScores: Partial<Record<RubricDimension, number>>;
  /**
   * PRD §7's judge rubric average: the mean of the `tone` mean and the `clarity` mean, so each dimension
   * weighs the same whatever the number of scenarios listing it (#34 r1/A-11); the one mean when only one
   * was scored.
   */
  rubricAverage?: number;
  /** `judge:` entries with no rubric, which report `skip`, and the scenarios of this run that list them. */
  unrubriced: { dimension: string; scenarioIds: string[] }[];
}

export interface RunSummary {
  cases: number;
  ran: number;
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  /** Mean per-case trial pass rate over cases that ran. */
  passAt1: number;
  /** Share of cases that ran where every trial passed. */
  passHatK: number;
  safetyViolations: number;
  /** Cases the `--max-cost` guard stopped before all their trials ran (unrun or partly run). */
  budgetStopped: number;
  /** Scenario mode: retried model calls (`attempt > 0`) across all trials (SPEC-1 decision, PR #71). */
  llmRetries?: number;
  /** L1: share of trials whose next action matched (`l1.action`). */
  toolCallAccuracy?: number;
  /** Scenario turns (or L1 calls), ms. */
  latencyMs: { p50: number; p95: number };
  /** Estimated spend, simulator included. */
  costUsd: number;
  /** Scenario mode: the patient simulator's share of `costUsd` (#31). */
  simulatorCostUsd?: number;
  /** Scenario mode: the LLM judge (#32). */
  judge?: JudgeSummary;
  /** Scenario mode: completed conversations, their turns, and agent cost per completed conversation (#34). */
  conversations?: ConversationMetrics;
}

export interface RunReport {
  schemaVersion: 1;
  mode: Mode;
  suite: Suite;
  profile: string;
  modelId: string;
  promptVersion: string;
  pricesAsOf: string;
  trialsPerCase: number;
  simulator?: string;
  /** Scenario mode with the judge on: which judge, on which model, with which rubrics (#32). */
  judge?: { name: string; profile: string; modelId: string; rubricVersion: string };
  llm: string;
  startedAt: string;
  finishedAt: string;
  wallClockMs: number;
  /** Budget guard: no new trial starts once spend reaches `maxCostUsd`; the trial running then can go over. */
  maxCostUsd?: number;
  rateLimit?: RateLimitStats;
  summary: RunSummary;
  cases: CaseResult[];
}

export interface RunSuiteOptions {
  mode: Mode;
  suite: Suite;
  llm: LlmClient;
  /** Label for the results file: `converse`, `scripted`, ... */
  llmName: string;
  profile: ModelProfile;
  trials: number;
  /** Default: the interim prompt. The report's `promptVersion` comes from the prompt it builds. */
  systemPrompt?: SystemPromptFactory;
  registry?: ToolRegistry;
  simulator?: PatientSimulator;
  /** Scenario mode: the LLM judge and its profile (#32). Undefined: the judge is off. */
  judge?: { judge: TrialJudge; profile: ModelProfile };
  /** Stop starting new trials once estimated spend reaches this (USD); the trial in flight can go over. */
  maxCostUsd?: number;
  /** Counters of the rate-limited client, read into the report when the run ends. */
  rateLimit?: { readonly stats: RateLimitStats };
  /** Progress callback, one line per trial. */
  onTrial?: (id: string, trial: TrialResult | L1TrialResult) => void;
}

function caseStatus(trials: readonly { status: string }[]): CaseStatus {
  if (trials.length === 0 || trials.every((t) => t.status === "skip")) return "skip";
  if (trials.some((t) => t.status === "error")) return "error";
  return trials.every((t) => t.status === "pass") ? "pass" : "fail";
}

const judgeResults = (t: TrialResult | L1TrialResult): GraderResult[] =>
  t.graders.filter((g) => g.kind === "judge");

/** The judge's summary over the trials that ran. */
export function summarizeJudge(
  trials: readonly (TrialResult | L1TrialResult)[],
  unrubriced: JudgeSummary["unrubriced"],
): JudgeSummary {
  const scenarioTrials = trials.filter((t): t is TrialResult => t.kind === "scenario");
  const scores = (d: string) =>
    scenarioTrials.flatMap((t) =>
      judgeResults(t).flatMap((g) => (g.name === `judge.${d}` && g.score !== undefined ? [g.score] : [])),
    );
  const meanScores: JudgeSummary["meanScores"] = {};
  for (const d of RUBRIC_DIMENSIONS) {
    const m = mean(scores(d));
    if (m !== undefined) meanScores[d] = m;
  }
  const rubricAverage = mean(
    (["tone", "clarity"] as const).flatMap((d) => (meanScores[d] === undefined ? [] : [meanScores[d]])),
  );
  return {
    costUsd: scenarioTrials.reduce((s, t) => s + t.judgeCost.costUsd, 0),
    judgedTrials: scenarioTrials.filter((t) => judgeResults(t).some((g) => g.score !== undefined)).length,
    fails: scenarioTrials.reduce((s, t) => s + judgeResults(t).filter((g) => g.status === "fail").length, 0),
    errors: scenarioTrials.filter((t) => t.judgeError !== undefined).length,
    meanScores,
    ...(rubricAverage === undefined ? {} : { rubricAverage }),
    unrubriced,
  };
}

export function summarize(
  mode: Mode,
  cases: readonly CaseResult[],
  unrubriced: JudgeSummary["unrubriced"] = [],
): RunSummary {
  const ran = cases.filter((c) => c.status !== "skip");
  const trials = ran.flatMap((c) => c.trials);
  const latencies =
    mode === "l1"
      ? trials.map((t) => t.durationMs)
      : trials.flatMap((t) => (t.kind === "scenario" ? t.turnDurationsMs : []));
  const l1Trials = trials.filter((t) => t.status !== "error" && t.graders.length > 0);
  return {
    cases: cases.length,
    ran: ran.length,
    passed: cases.filter((c) => c.status === "pass").length,
    failed: cases.filter((c) => c.status === "fail").length,
    skipped: cases.filter((c) => c.status === "skip").length,
    errored: cases.filter((c) => c.status === "error").length,
    passAt1: ran.length === 0 ? 0 : ran.reduce((s, c) => s + c.passRate, 0) / ran.length,
    passHatK: ran.length === 0 ? 0 : ran.filter((c) => c.passHatK).length / ran.length,
    safetyViolations: trials.reduce((s, t) => s + t.safetyViolations, 0),
    budgetStopped: cases.filter((c) => c.budgetStopped).length,
    ...(mode === "scenario"
      ? {
          llmRetries: trials.reduce((s, t) => s + (t.kind === "scenario" ? t.llmRetries : 0), 0),
          simulatorCostUsd: trials.reduce(
            (s, t) => s + (t.kind === "scenario" ? t.simulatorCost.costUsd : 0),
            0,
          ),
          judge: summarizeJudge(trials, unrubriced),
          conversations: conversationMetrics(trials),
        }
      : {}),
    ...(mode === "l1"
      ? {
          toolCallAccuracy:
            l1Trials.length === 0
              ? 0
              : l1Trials.filter((t) => t.graders.some((g) => g.name === L1_ACTION && g.status === "pass"))
                  .length / l1Trials.length,
        }
      : {}),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    costUsd: trials.reduce((s, t) => s + t.costUsd, 0),
  };
}

export async function runSuite(
  cases: readonly (Scenario | L1Case)[],
  options: RunSuiteOptions,
): Promise<RunReport> {
  const startedAt = new Date();
  const t0 = performance.now();
  const results: CaseResult[] = [];
  let spent = 0;

  const overBudget = () => options.maxCostUsd !== undefined && spent >= options.maxCostUsd;
  const systemPrompt = options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt };
  const runTrial = (c: Scenario | L1Case, trial: number): Promise<TrialResult | L1TrialResult> => {
    if (isL1Case(c) !== (options.mode === "l1"))
      throw new Error(`${c.id} is not ${options.mode === "l1" ? "an L1 case" : "a scenario"}`);
    return isL1Case(c)
      ? runL1Trial(c, { llm: options.llm, profile: options.profile, trial, ...systemPrompt })
      : runScenarioTrial(c, {
          trial,
          agent: {
            llm: options.llm,
            profile: options.profile,
            ...systemPrompt,
            ...(options.registry === undefined ? {} : { registry: options.registry }),
          },
          ...(options.simulator === undefined ? {} : { simulator: options.simulator }),
          ...(options.judge === undefined ? {} : { judge: options.judge.judge }),
        });
  };

  for (const c of cases) {
    const trials: (TrialResult | L1TrialResult)[] = [];
    let budgetStopped = false;
    for (let trial = 1; trial <= options.trials; trial++) {
      if (overBudget()) {
        budgetStopped = true;
        break;
      }
      const result = await runTrial(c, trial);
      // The budget sees every call: the conversation's, and the judge's (r1/Q-2 (a)).
      spent += result.costUsd + (result.kind === "scenario" ? result.judgeCost.costUsd : 0);
      trials.push(result);
      options.onTrial?.(c.id, result);
      if (result.status === "skip") break; // a skip reason holds for every trial
    }
    const ran = trials.filter((t) => t.status !== "skip");
    const passedTrials = ran.filter((t) => t.status === "pass").length;
    results.push({
      id: c.id,
      category: c.category,
      tags: c.tags,
      status: caseStatus(trials),
      passRate: ran.length === 0 ? 0 : passedTrials / ran.length,
      passHatK: ran.length === options.trials && passedTrials === options.trials,
      ...(budgetStopped
        ? {
            budgetStopped: true as const,
            reason: `budget guard ($${String(options.maxCostUsd)} reached) after ${trials.length} of ${options.trials} trial(s)`,
          }
        : {}),
      trials,
    });
  }

  const finishedAt = new Date();
  return {
    schemaVersion: 1,
    mode: options.mode,
    suite: options.suite,
    profile: options.profile.name,
    modelId: options.profile.modelId,
    promptVersion: promptFor(options.systemPrompt, startedAt, undefined).version,
    pricesAsOf: PRICES_AS_OF,
    trialsPerCase: options.trials,
    ...(options.mode === "scenario" ? { simulator: (options.simulator ?? scriptOnlySimulator).name } : {}),
    ...(options.mode === "scenario" && options.judge !== undefined
      ? {
          judge: {
            name: options.judge.judge.name,
            profile: options.judge.profile.name,
            modelId: options.judge.profile.modelId,
            rubricVersion: JUDGE_RUBRIC_VERSION,
          },
        }
      : {}),
    llm: options.llmName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallClockMs: Math.round(performance.now() - t0),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    ...(options.rateLimit === undefined ? {} : { rateLimit: { ...options.rateLimit.stats } }),
    summary: summarize(
      options.mode,
      results,
      unrubricedInUse(cases.filter((c): c is Scenario => !isL1Case(c))),
    ),
    cases: results,
  };
}

/**
 * What went wrong in a trial: each failed deterministic grader as `name: detail`, then the trial's
 * reason, if any. Judge scores below the pass mark are `judgeFails`, since they don't fail a trial.
 */
export const failedChecks = (t: TrialResult | L1TrialResult): string[] => [
  ...t.graders.filter(isDeterministicFailure).map((g) => `${g.name}: ${g.detail ?? ""}`),
  ...(t.reason !== undefined && t.status !== "pass" ? [t.reason] : []),
];

/** The judge's scores below the pass mark in a trial, as `judge.<dimension> <score>/5`. */
export const judgeFails = (t: TrialResult | L1TrialResult): string[] =>
  judgeResults(t)
    .filter((g) => g.status === "fail")
    .map((g) => `${g.name} ${String(g.score)}/5`);

export { pct };

/** The judge's line in the markdown summary, and the unrubriced dimensions, if any. */
function judgeLines(report: RunReport, j: JudgeSummary): string[] {
  const means = Object.entries(j.meanScores)
    .map(([d, m]) => `${d} ${m.toFixed(2)}`)
    .join(", ");
  return [
    `- Judge: ${report.judge === undefined ? "off" : `${report.judge.name} (\`${report.judge.modelId}\`)`} · cost $${j.costUsd.toFixed(4)} (not in the estimate above) · ${j.judgedTrials} trial(s) judged · ${j.fails} score(s) below ${PASS_SCORE} · ${j.errors} judge error(s)${j.rubricAverage === undefined ? "" : ` · rubric average (tone, clarity) ${j.rubricAverage.toFixed(2)}`}${means === "" ? "" : ` · means: ${means}`}`,
    ...(j.unrubriced.length === 0
      ? []
      : [
          `- Judge dimensions without a rubric (skipped): ${j.unrubriced.map((u) => `${u.dimension} (${u.scenarioIds.join(", ")})`).join("; ")}`,
        ]),
  ];
}

/** A short markdown summary for the terminal and the `.md` next to the JSON. */
export function markdownSummary(report: RunReport): string {
  const s = report.summary;
  const lines = [
    `# Eval run: ${report.mode} / ${report.suite} / ${report.profile}`,
    "",
    `- Model: \`${report.modelId}\` · prompt \`${report.promptVersion}\` · ${report.trialsPerCase} trial(s) per case · LLM: ${report.llm}${report.simulator ? ` · simulator: ${report.simulator}` : ""}`,
    `- Cases: ${s.cases} (ran ${s.ran}, passed ${s.passed}, failed ${s.failed}, errored ${s.errored}, skipped ${s.skipped})`,
    `- pass@1 ${pct(s.passAt1)} · pass^k ${pct(s.passHatK)}${s.toolCallAccuracy === undefined ? "" : ` · tool-call accuracy ${pct(s.toolCallAccuracy)}`} · safety violations ${s.safetyViolations}${s.budgetStopped > 0 ? ` · budget guard stopped ${s.budgetStopped} case(s)` : ""}${s.llmRetries === undefined ? "" : ` · model retries ${s.llmRetries}`}`,
    `- Latency p50 ${s.latencyMs.p50} ms · p95 ${s.latencyMs.p95} ms · wall-clock ${(report.wallClockMs / 1000).toFixed(1)} s`,
    `- Estimated cost $${s.costUsd.toFixed(4)}${s.simulatorCostUsd === undefined ? "" : ` (simulator $${s.simulatorCostUsd.toFixed(4)})`} (list prices as of ${report.pricesAsOf})${report.rateLimit ? ` · ${report.rateLimit.calls} calls, ${report.rateLimit.retries} retries, ${report.rateLimit.throttles} throttled` : ""}`,
    ...(s.judge === undefined ? [] : judgeLines(report, s.judge)),
    ...(s.conversations === undefined ? [] : [conversationLine(s.conversations)]),
    ...exitHalfLines(report),
    "",
    `| Case | Status | Pass rate | Failed checks | Judge below ${PASS_SCORE} |`,
    "|---|---|---|---|---|",
  ];
  for (const c of report.cases) {
    const failed = [
      ...new Set([...(c.reason === undefined ? [] : [c.reason]), ...c.trials.flatMap(failedChecks)]),
    ];
    const judged = [...new Set(c.trials.flatMap(judgeFails))];
    lines.push(
      `| ${c.id} | ${c.status} | ${c.status === "skip" ? "–" : pct(c.passRate)} | ${failed.join("<br>").replaceAll("|", "\\|").slice(0, 400)} | ${judged.join("<br>")} |`,
    );
  }
  lines.push(...drillDown(report, failedChecks));
  return lines.join("\n");
}
