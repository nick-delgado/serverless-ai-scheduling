/**
 * Maps a failed agent turn to its patient-safe failure (ADR-007). Apart from `errors.ts` because it
 * imports `@sched/agent` (for the shared throttle rule, #105), which the session Lambda must not bundle;
 * only the chat turn imports this file.
 */
import { isThrottle } from "@sched/agent";

import { FAILURES, type ChatFailure } from "./errors";

/**
 * A failed agent turn (`outcome: "error"`: a model call threw after the SDK's retries, or the turn's
 * deadline aborted it). Throttling (`isThrottle`: a throttling name or HTTP 429) → RATE_LIMITED;
 * anything else → AGENT_UNAVAILABLE. Both retryable.
 */
export function classifyAgentError(error: unknown): ChatFailure {
  return isThrottle(error) ? FAILURES.throttled() : FAILURES.unavailable();
}
