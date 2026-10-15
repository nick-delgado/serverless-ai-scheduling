/**
 * Structured logging (NFR-007, ADR-009). Log entries carry IDs, timings, counts and token usage, never
 * message text: not the patient's words, not the model's reply, not tool inputs (`reason` and `summary`
 * are patient free text). The per-turn trace with tool inputs goes to DynamoDB instead, with a TTL.
 */

export type LogLevel = "info" | "warn" | "error";

/** One structured entry. Values must be IDs, enums, numbers or booleans: never free text. */
export interface LogEntry {
  msg: string;
  level?: LogLevel;
  [key: string]: unknown;
}

export type Logger = (entry: LogEntry) => void;

export const silentLogger: Logger = () => undefined;

// The Lambdas write entries through a Powertools Logger (`observability/logger.ts`, #38).

/**
 * What to log about an error: its name, its AWS error code and HTTP status if any, and a clipped
 * message. AWS SDK and Bedrock error messages describe the failure, not the conversation.
 */
export function errorSummary(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { errorType: typeof error };
  const meta = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  const code = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    errorMessage: error.message.slice(0, 200),
    ...(typeof code === "string" ? { errorCode: code } : {}),
    ...(meta?.httpStatusCode === undefined ? {} : { httpStatus: meta.httpStatusCode }),
  };
}
