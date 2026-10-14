/**
 * Per-invocation instrumentation of the Lambda handlers (#38).
 *
 * Powertools' own handler wrappers (`injectLambdaContext`, `logMetrics`, `captureLambdaHandler`, as
 * decorators or Middy middleware) read the Lambda context from the handler's second argument. A
 * `streamifyResponse` handler gets `(event, responseStream, context)`, so they would read the response
 * stream as the context (assumption A-5, checked against `@aws-lambda-powertools` 2.36). These wrappers do
 * the two jobs we need by hand, with the context from the right argument:
 * - `addContext`, so every log line carries the Lambda request ID, the function name and `cold_start`;
 * - for the chat function, one flush of the stored metrics per invocation, after the turn, even if it
 *   throws. Nothing is written when nothing was stored.
 * The X-Ray tracer needs neither: it captures the SDK clients (`handlers/chat.ts`).
 */
import type { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import type { Metrics } from "@aws-lambda-powertools/metrics";

type LambdaContext = Parameters<PowertoolsLogger["addContext"]>[0];

export type ContextLogger = Pick<PowertoolsLogger, "addContext">;

function addContext(logger: ContextLogger, context: unknown): void {
  if (typeof context === "object" && context !== null) logger.addContext(context as LambdaContext);
}

/** A buffered `(event, context)` handler whose log lines carry the invocation's Lambda context. */
export function withLambdaContext<E, R>(
  logger: ContextLogger,
  handler: (event: E) => Promise<R>,
): (event: E, context?: unknown) => Promise<R> {
  return (event, context) => {
    addContext(logger, context);
    return handler(event);
  };
}

/**
 * A streaming handler whose log lines carry the invocation's Lambda context, and whose stored metrics are
 * flushed once when it ends.
 */
export function instrumentStreamHandler<E>(
  handler: awslambda.StreamifyHandler<E>,
  options: { logger: ContextLogger; metrics: Pick<Metrics, "hasStoredMetrics" | "publishStoredMetrics"> },
): awslambda.StreamifyHandler<E> {
  return async (event, responseStream, context) => {
    addContext(options.logger, context);
    try {
      await handler(event, responseStream, context);
    } finally {
      if (options.metrics.hasStoredMetrics()) options.metrics.publishStoredMetrics();
    }
  };
}
