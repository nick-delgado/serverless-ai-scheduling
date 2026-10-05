/**
 * Token-usage sums, shared by the agent loop and the eval harness (runner, simulator, judge), which kept
 * their own copy until #105. A leaf module.
 */
import type { TokenUsage } from "@sched/contracts";

/** No tokens yet. A fresh object each call, so callers may mutate it. */
export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** The field-by-field sum of two usages. */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
