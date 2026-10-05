/**
 * Patient-safe terminal `error` events for the chat stream (ADR-007), with the HTTP status to use if
 * nothing has been streamed yet. Details go to the log, never to the client.
 */
import { DAILY_CAP_MESSAGE, type ChatErrorCode, type ChatStreamEvent } from "@sched/contracts";

export type ChatErrorEvent = Extract<ChatStreamEvent, { type: "error" }>;

export interface ChatFailure {
  httpStatus: number;
  event: ChatErrorEvent;
}

function failure(httpStatus: number, code: ChatErrorCode, message: string, retryable: boolean): ChatFailure {
  return { httpStatus, event: { type: "error", code, message, retryable } };
}

export const FAILURES = {
  unauthorized: () => failure(401, "UNAUTHORIZED", "Please sign in again.", false),
  badRequest: () => failure(400, "BAD_REQUEST", "The message couldn't be read. Please try again.", false),
  dailyCap: () => failure(429, "RATE_LIMITED", DAILY_CAP_MESSAGE, false),
  throttled: () =>
    failure(429, "RATE_LIMITED", "The assistant is busy right now. Please try again in a moment.", true),
  unavailable: () =>
    failure(503, "AGENT_UNAVAILABLE", "The assistant is temporarily unavailable. Please try again.", true),
  /** Another turn of this conversation wrote first (the history we loaded is stale). */
  conflict: () =>
    failure(
      409,
      "AGENT_UNAVAILABLE",
      "Your previous message is still being answered. Please try again in a moment.",
      true,
    ),
  internal: () => failure(500, "INTERNAL", "Something went wrong on our side.", false),
} as const;

const THROTTLING = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceQuotaExceededException",
]);

/**
 * A failed agent turn (`outcome: "error"`: a model call threw after the SDK's retries, or the turn's
 * deadline aborted it). Throttling → RATE_LIMITED; anything else → AGENT_UNAVAILABLE. Both retryable.
 */
export function classifyAgentError(error: unknown): ChatFailure {
  const name = error instanceof Error ? error.name : undefined;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
  if ((name !== undefined && THROTTLING.has(name)) || status === 429) return FAILURES.throttled();
  return FAILURES.unavailable();
}
