/**
 * FR-010's greeting budget (#40, r1/Q-6 (a)): the greeting appears within 1.5 s of page load at p95, signed in and
 * warm. Pure; `fr010.greeting.ts` measures the samples. Percentiles are nearest-rank (`percentile` from
 * `@sched/evals`, the rule ADR-006's p95 uses), so with 50 samples the p95 is the 48th smallest.
 */
import { percentile } from "@sched/evals";

/** FR-010's budget, in milliseconds. A p95 of exactly this passes ("within"). */
export const GREETING_BUDGET_MS = 1500;

export interface GreetingSummary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Loads whose `POST /api/session` didn't return 200; they're not in the samples. */
  discarded: number;
  withinBudget: boolean;
}

export function summarizeGreeting(samples: readonly number[], discarded: number): GreetingSummary {
  const p95 = percentile(samples, 95);
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95,
    max: samples.length === 0 ? 0 : Math.max(...samples),
    discarded,
    withinBudget: samples.length > 0 && p95 <= GREETING_BUDGET_MS,
  };
}

export function formatGreeting(s: GreetingSummary): string {
  const ms = (v: number) => `${String(Math.round(v))} ms`;
  const verdict = s.withinBudget ? "within" : "over";
  return (
    `FR-010 greeting: n=${String(s.n)}, p50 ${ms(s.p50)}, p95 ${ms(s.p95)}, max ${ms(s.max)}, ` +
    `discarded ${String(s.discarded)}; p95 ${verdict} the ${ms(GREETING_BUDGET_MS)} budget`
  );
}
