/**
 * Adapts `handleChatTurn` to the Lambda response-streaming runtime behind the REST API
 * (`responseTransferMode: STREAM`, ADR-007).
 */
import { handleChatTurn, type ChatTurnDeps } from "./chat-turn";
import { bodyText, patientIdFromEvent, type RestApiProxyEvent } from "./request";
import { responseStreamSink } from "./stream";

/** The part of the Lambda context we use. */
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

/**
 * Time kept back from the agent loop at the function's deadline, so the turn can still store what
 * happened and end the stream with `error` instead of being killed mid-write.
 */
export const PERSIST_RESERVE_MS = 15_000;

export interface Deadline {
  signal: AbortSignal;
  /** Stops the timer once the turn is over, so it can't fire into a later invocation. */
  cancel(): void;
}

/** An AbortSignal that fires `reserveMs` before the function times out (at least 1 s from now). */
export function deadlineSignal(context: unknown, reserveMs = PERSIST_RESERVE_MS): Deadline | undefined {
  const remaining = (context as Partial<LambdaContext> | undefined)?.getRemainingTimeInMillis?.();
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The turn reached its deadline.", "TimeoutError")),
    Math.max(1_000, remaining - reserveMs),
  );
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

export function chatStreamHandler(deps: ChatTurnDeps): awslambda.StreamifyHandler<RestApiProxyEvent> {
  return async (event, responseStream, context) => {
    const deadline = deadlineSignal(context);
    try {
      await handleChatTurn(
        {
          body: bodyText(event),
          patientId: patientIdFromEvent(event),
          requestId: event.requestContext.requestId,
          ...(deadline ? { signal: deadline.signal } : {}),
        },
        deps,
        responseStreamSink(responseStream),
      );
    } finally {
      deadline?.cancel();
    }
  };
}
