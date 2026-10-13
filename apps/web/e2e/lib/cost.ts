/**
 * The run's estimated Bedrock cost (#40, r1/A-8): the sum of `estimateCostUsd` over the turn traces (`TRACE#` items)
 * of the conversations the run started. List prices, so an estimate, not billed spend. Pure; `cost-reporter.ts`
 * reads the traces.
 */
import { estimateCostUsd, isModelProfileName, MODEL_PROFILES } from "@sched/agent";
import type { TurnTrace } from "@sched/contracts";

export interface RunCost {
  usd: number;
  turns: number;
}

/** Sums each trace's usage at its profile's prices. Throws on a profile this checkout doesn't price. */
export function sumTraceCost(traces: readonly Pick<TurnTrace, "modelProfile" | "usage">[]): RunCost {
  let usd = 0;
  for (const trace of traces) {
    if (!isModelProfileName(trace.modelProfile))
      throw new Error(`No prices for model profile "${trace.modelProfile}"`);
    usd += estimateCostUsd(MODEL_PROFILES[trace.modelProfile], trace.usage);
  }
  return { usd, turns: traces.length };
}

/** The line the run ends with (r1/A-8). */
export function formatRunCost(cost: RunCost): string {
  return `Estimated Bedrock cost (list prices): $${cost.usd.toFixed(4)} over ${String(cost.turns)} turns`;
}
