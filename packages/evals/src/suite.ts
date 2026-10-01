/**
 * Runs a suite (many cases × k trials) and aggregates the ADR-008 metrics: pass@1, pass^k, safety
 * violations, L1 tool-call accuracy, latency, cost, and wall-clock.
 */
import { PRICES_AS_OF, type LlmClient, type ModelProfile } from "@sched/agent";
import type { ToolRegistry } from "@sched/tools";

import { runL1Trial, type L1TrialResult } from "./l1";
import type { L1Case, Scenario } from "./schema";
import { runScenarioTrial, type TrialResult } from "./runner";
import type { PatientSimulator } from "./simulator";
import { INTERIM_PROMPT_VERSION, type SystemPromptFactory } from "./system-prompt";

export type Mode = "l1" | "scenario";
export type CaseStatus = "pass" | "fail" | "skip" | "error";

export interface CaseResult {
  id: string;
  category: string;
  tags: string[];
  status: CaseStatus;
  /** Passed trials / trials run. */
  passRate: number;
  /** All k trials passed (pass^k). */
  passHatK: boolean;
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
  /** L1: share of trials whose next action matched (`l1.action`). */
  toolCallAccuracy?: number;
  /** Scenario turns (or L1 calls), ms. */
  latencyMs: { p50: number; p95: number };
  costUsd: number;
}

export interface RunReport {
  schemaVersion: 1;
  mode: Mode;
  suite: string;
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
  /** Budget guard: cases left unrun once spend reached `maxCostUsd`. */
  maxCostUsd?: number;
  rateLimit?: { calls: number; retries: number; throttles: number };
  summary: RunSummary;
  cases: CaseResult[];
}

export interface RunSuiteOptions {
  mode: Mode;
  suite: string;
  llm: LlmClient;
  /** Label for the results file: `converse`, `scripted`, ... */
  llmName: string;
  profile: ModelProfile;
  trials: number;
  systemPrompt?: SystemPromptFactory;
  promptVersion?: string;
  registry?: ToolRegistry;
  simulator?: PatientSimulator;
  /** Stop starting trials once estimated spend reaches this (USD). */
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

  for (const c of cases) {
    const trials: (TrialResult | L1TrialResult)[] = [];
    for (let trial = 1; trial <= options.trials; trial++) {
      if (options.maxCostUsd !== undefined && spent >= options.maxCostUsd) break;
      const result =
        options.mode === "l1"
          ? await runL1Trial(c as L1Case, {
              llm: options.llm,
              profile: options.profile,
              trial,
              ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
            })
          : await runScenarioTrial(c as Scenario, {
              trial,
              agent: {
                llm: options.llm,
                profile: options.profile,
                ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
                ...(options.registry === undefined ? {} : { registry: options.registry }),
              },
              ...(options.simulator === undefined ? {} : { simulator: options.simulator }),
            });
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
      status: trials.length === 0 ? "skip" : caseStatus(trials),
      passRate: ran.length === 0 ? 0 : passedTrials / ran.length,
      passHatK: ran.length === options.trials && passedTrials === options.trials,
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
    promptVersion: options.promptVersion ?? INTERIM_PROMPT_VERSION,
    pricesAsOf: PRICES_AS_OF,
    trialsPerCase: options.trials,
    ...(options.mode === "scenario" ? { simulator: options.simulator?.name ?? "script-only" } : {}),
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
    `- pass@1 ${pct(s.passAt1)} · pass^k ${pct(s.passHatK)}${s.toolCallAccuracy === undefined ? "" : ` · tool-call accuracy ${pct(s.toolCallAccuracy)}`} · safety violations ${s.safetyViolations}`,
    `- Latency p50 ${s.latencyMs.p50} ms · p95 ${s.latencyMs.p95} ms · wall-clock ${(report.wallClockMs / 1000).toFixed(1)} s`,
    `- Estimated cost $${s.costUsd.toFixed(4)} (list prices as of ${report.pricesAsOf})${report.rateLimit ? ` · ${report.rateLimit.calls} calls, ${report.rateLimit.retries} retries, ${report.rateLimit.throttles} throttled` : ""}`,
    "",
    "| Case | Status | Pass rate | Failed checks |",
    "|---|---|---|---|",
  ];
  for (const c of report.cases) {
    const failed = [
      ...new Set(
        c.trials.flatMap((t) => [
          ...t.graders.filter((g) => g.status === "fail").map((g) => `${g.name}: ${g.detail ?? ""}`),
          ...("reason" in t && t.reason !== undefined && t.status !== "pass" ? [t.reason] : []),
        ]),
      ),
    ];
    lines.push(
      `| ${c.id} | ${c.status} | ${c.status === "skip" ? "–" : pct(c.passRate)} | ${failed.join("<br>").replaceAll("|", "\\|").slice(0, 400)} |`,
    );
  }
  return lines.join("\n");
}
