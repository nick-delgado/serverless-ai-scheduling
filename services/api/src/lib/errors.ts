/**
 * Patient-safe terminal `error` events for the chat stream (ADR-007), with the HTTP status to use if
 * nothing has been streamed yet. Details go to the log, never to the client.
 *
 * The session Lambda imports this file and must not bundle `@sched/agent` (`test/session-bundle.test.ts`),
 * so nothing here imports it: classifying a failed agent turn is in `agent-errors.ts` (#105).
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
