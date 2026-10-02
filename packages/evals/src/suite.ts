/**
 * Runs a suite (many cases × k trials) and aggregates the ADR-008 metrics: pass@1, pass^k, safety
 * violations, L1 tool-call accuracy, latency, cost, and wall-clock.
 */
import { PRICES_AS_OF, type LlmClient, type ModelProfile } from "@sched/agent";
import type { ToolRegistry } from "@sched/tools";

import { runL1Trial, type L1TrialResult } from "./l1";
import type { Suite } from "./loader";
import type { RateLimitStats } from "./rate-limit";
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
  costUsd: number;
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
  /** Stop starting new trials once estimated spend reaches this (USD); the trial in flight can go over. */
  maxCostUsd?: number;
  /** Progress callback, one line per trial. */
  onTrial?: (id: string, trial: TrialResult | L1TrialResult) => void;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function caseStatus(trials: readonly { status: string }[]): CaseStatus {
  if (trials.length === 0 || trials.every((t) => t.status === "skip")) return "skip";
  if (trials.some((t) => t.status === "error")) return "error";
  return trials.every((t) => t.status === "pass") ? "pass" : "fail";
}

export function summarize(mode: Mode, cases: readonly CaseResult[]): RunSummary {
  const ran = cases.filter((c) => c.status !== "skip");
  const trials = ran.flatMap((c) => c.trials);
  const latencies =
    mode === "l1"
      ? trials.map((t) => t.durationMs)
      : trials.flatMap((t) => ("turnDurationsMs" in t ? t.turnDurationsMs : []));
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
      ? { llmRetries: trials.reduce((s, t) => s + ("llmRetries" in t ? t.llmRetries : 0), 0) }
      : {}),
    ...(mode === "l1"
      ? {
          toolCallAccuracy:
            l1Trials.length === 0
              ? 0
              : l1Trials.filter((t) => t.graders.some((g) => g.name === "l1.action" && g.status === "pass"))
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
      spent += result.costUsd;
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
    llm: options.llmName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallClockMs: Math.round(performance.now() - t0),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    summary: summarize(options.mode, results),
    cases: results,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

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
    `- Estimated cost $${s.costUsd.toFixed(4)} (list prices as of ${report.pricesAsOf})${report.rateLimit ? ` · ${report.rateLimit.calls} calls, ${report.rateLimit.retries} retries, ${report.rateLimit.throttles} throttled` : ""}`,
    "",
    "| Case | Status | Pass rate | Failed checks |",
    "|---|---|---|---|",
  ];
  for (const c of report.cases) {
    const failed = [
      ...new Set([
        ...(c.reason === undefined ? [] : [c.reason]),
        ...c.trials.flatMap((t) => [
          ...t.graders.filter((g) => g.status === "fail").map((g) => `${g.name}: ${g.detail ?? ""}`),
          ...(t.reason !== undefined && t.status !== "pass" ? [t.reason] : []),
        ]),
      ]),
    ];
    lines.push(
      `| ${c.id} | ${c.status} | ${c.status === "skip" ? "–" : pct(c.passRate)} | ${failed.join("<br>").replaceAll("|", "\\|").slice(0, 400)} |`,
    );
  }
  return lines.join("\n");
}
