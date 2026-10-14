/**
 * The Lambdas' log writer: a Powertools `Logger` behind our `Logger` type (#38, owner decision r1/Q-4 (a)).
 * The log calls in `chat-turn.ts` and `session.ts` and their field names don't change; the entry's `msg`
 * becomes the line's `message`, and Powertools adds its own keys (`level`, `timestamp`, `service`,
 * `cold_start` and the Lambda request ID once `addContext` has run, and `xray_trace_id` when tracing is on).
 *
 * Powertools writes each line through its own `Console` on stdout (stderr for warn and error), not through
 * the global `console` that the Lambda runtime wraps under `LogFormat: JSON`. So a line is one top-level
 * JSON object, no longer nested under `message` as `console.info` output was (ADR-002's NFR-001 query,
 * amended by #38). The Lambda event and the request body are never logged (ADR-009).
 */
import { Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";

import type { Logger } from "../log";

/** The part of a Powertools Logger that writes entries. */
export type LogWriter = Pick<PowertoolsLogger, "info" | "warn" | "error">;

/** A Powertools Logger for one function. `service` is the line's `service` key. */
export function createPowertoolsLogger(service: string): PowertoolsLogger {
  return new PowertoolsLogger({ serviceName: service });
}

/** Writes each entry at its level, with `msg` as the message and every other field at the top level. */
export function powertoolsLogger(writer: LogWriter): Logger {
  return ({ msg, level = "info", ...fields }) => {
    writer[level](msg, fields);
  };
}
