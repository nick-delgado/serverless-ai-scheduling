/**
 * The chat function's CloudWatch metrics (#38, NFR-007): Powertools `Metrics` writing embedded-metric (EMF)
 * records, namespace `Sched`, dimension `Env` (owner decisions r1/Q-2 (a), Q-3 (a), Q-6 (a)).
 *
 * - **Per turn:** `withTurnMetrics` decorates the turn's `Logger`. It passes every entry on unchanged and,
 *   for the `"chat turn"` entry, reads the turn's figures from it, so `chat-turn.ts` doesn't change. The
 *   population rules (Q-3): every turn counts in `Turns`; a replay counts nowhere else; a turn ending
 *   `error` counts in `TurnErrors`; `TimeToFirstTextMs` is the turn's `firstTextMs` (the first `text_delta`,
 *   NFR-001) and `TurnLatencyMs` its `totalMs` when it ends `done`, both timed from the handler's start
 *   (A-1); the token sums and tool counts come only from a turn whose agent loop ran. A figure the turn
 *   lacks is left out, never written as zero.
 * - **Records:** the turn's `Env` figures go into the function's metrics store, which the handler wrapper
 *   flushes once per invocation (`lambda.ts`), together with any `BookingConflictRetries`. One EMF record
 *   has one value per dimension, so the `Env`+`ErrorCode` figures are records of their own, written at
 *   once: one for a turn's error code, and one per tool error code the turn saw.
 * - **Raw stdout:** Powertools writes each record through its own `Console` on `process.stdout`, not the
 *   global `console` that `LogFormat: JSON` wraps, so CloudWatch reads it as EMF (A-4, pinned by
 *   `test/observability-metrics.test.ts`).
 * - IDs (`requestId`, `conversationId`, `turnId`) are EMF properties, never dimensions (ADR-009: no text).
 */
import { MetricUnit, Metrics } from "@aws-lambda-powertools/metrics";
import { NOTIFICATION_FAILED_METRIC } from "@sched/tools/ses";

import type { LogEntry, Logger } from "../log";

/** Shared with #35's `NotificationFailed`, so the dashboard and the alarm read one namespace. */
export const METRICS_NAMESPACE = NOTIFICATION_FAILED_METRIC.namespace;
export const ENV_DIMENSION = NOTIFICATION_FAILED_METRIC.dimension;
export const ERROR_CODE_DIMENSION = "ErrorCode";

/** The metric names (owner decision r1/Q-3 (a)); `infra/stacks/api.yaml`'s dashboard reads them. */
export const METRIC = {
  turns: "Turns",
  turnErrors: "TurnErrors",
  timeToFirstText: "TimeToFirstTextMs",
  turnLatency: "TurnLatencyMs",
  inputTokens: "InputTokens",
  outputTokens: "OutputTokens",
  cacheReadTokens: "CacheReadTokens",
  cacheWriteTokens: "CacheWriteTokens",
  toolCalls: "ToolCalls",
  toolErrors: "ToolErrors",
  bookingConflictRetries: "BookingConflictRetries",
} as const;

/** The log entry `chat-turn.ts` writes once per turn. */
export const CHAT_TURN_MSG = "chat turn";

type Unit = (typeof MetricUnit)[keyof typeof MetricUnit];

export interface TurnFigure {
  name: string;
  unit: Unit;
  value: number;
}

/** A figure written under `Env`+`ErrorCode`. */
export interface CodedFigure {
  name: string;
  code: string;
  value: number;
}

export interface TurnFigures {
  /** Under `Env` only. */
  figures: TurnFigure[];
  /** Under `Env`+`ErrorCode`, one record each. */
  coded: CodedFigure[];
  /** The turn's IDs, as EMF properties. */
  ids: Record<string, string>;
}

/** A `Metrics` writing to namespace `Sched` under the `Env` dimension and no other (Powertools adds `service`). */
export function envMetrics(env: string): Metrics {
  const metrics = new Metrics({ namespace: METRICS_NAMESPACE });
  metrics.clearDefaultDimensions();
  metrics.setDefaultDimensions({ [ENV_DIMENSION]: env });
  return metrics;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** An error code as a dimension value; `UNKNOWN` when the entry has none (no path writes one today). */
const codeOf = (v: unknown): string => (typeof v === "string" ? v : "UNKNOWN");

const TOKEN_FIGURES = [
  ["inputTokens", METRIC.inputTokens],
  ["outputTokens", METRIC.outputTokens],
  ["cacheReadTokens", METRIC.cacheReadTokens],
  ["cacheWriteTokens", METRIC.cacheWriteTokens],
] as const;

/**
 * The metrics of one `"chat turn"` entry, or a list of the fields it lacks. Reads `replayed`, `terminal`,
 * `errorCode`, `firstTextMs`, `totalMs`, `usage` and `tools`, and the IDs.
 */
export function turnFigures(entry: LogEntry): TurnFigures | { missing: string[] } {
  const { replayed, terminal, errorCode, firstTextMs, totalMs, usage, tools } = entry;
  const missing = [
    ...(typeof replayed === "boolean" ? [] : ["replayed"]),
    ...(terminal === "done" || terminal === "error" ? [] : ["terminal"]),
    ...(isNumber(totalMs) ? [] : ["totalMs"]),
  ];
  if (missing.length > 0) return { missing };
  const latency = totalMs as number; // checked above

  const ids = Object.fromEntries(
    (["requestId", "conversationId", "turnId"] as const).flatMap((k) =>
      typeof entry[k] === "string" ? [[k, entry[k]]] : [],
    ),
  );
  const figures: TurnFigure[] = [{ name: METRIC.turns, unit: MetricUnit.Count, value: 1 }];
  const coded: CodedFigure[] = [];
  if (replayed) return { figures, coded, ids };

  const failed = terminal === "error";
  figures.push({ name: METRIC.turnErrors, unit: MetricUnit.Count, value: failed ? 1 : 0 });
  if (failed) coded.push({ name: METRIC.turnErrors, code: codeOf(errorCode), value: 1 });
  if (isNumber(firstTextMs)) {
    figures.push({ name: METRIC.timeToFirstText, unit: MetricUnit.Milliseconds, value: firstTextMs });
  }
  if (!failed) figures.push({ name: METRIC.turnLatency, unit: MetricUnit.Milliseconds, value: latency });
  if (isRecord(usage)) {
    for (const [field, name] of TOKEN_FIGURES) {
      const value = usage[field];
      if (isNumber(value)) figures.push({ name, unit: MetricUnit.Count, value });
    }
  }
  if (Array.isArray(tools)) {
    const errors = new Map<string, number>();
    for (const call of tools as unknown[]) {
      if (!isRecord(call) || call.ok !== false) continue;
      const code = codeOf(call.errorCode);
      errors.set(code, (errors.get(code) ?? 0) + 1);
    }
    const errorCount = [...errors.values()].reduce((a, b) => a + b, 0);
    figures.push({ name: METRIC.toolCalls, unit: MetricUnit.Count, value: tools.length });
    figures.push({ name: METRIC.toolErrors, unit: MetricUnit.Count, value: errorCount });
    for (const [code, value] of errors) coded.push({ name: METRIC.toolErrors, code, value });
  }
  return { figures, coded, ids };
}

export interface TurnMetricsTarget {
  /** The function's store under `Env`, flushed once per invocation by the handler wrapper. */
  turn: Metrics;
  /** Writes each `Env`+`ErrorCode` record at once. */
  coded: Metrics;
}

/**
 * `log`, which also turns the `"chat turn"` entry into the turn's metrics. An entry missing a field the
 * metrics read is logged as a warning (field names only), and no metric is written for that turn.
 */
export function withTurnMetrics(log: Logger, target: TurnMetricsTarget): Logger {
  return (entry) => {
    log(entry);
    if (entry.msg !== CHAT_TURN_MSG) return;
    const result = turnFigures(entry);
    if ("missing" in result) {
      log({ msg: "turn metrics skipped", level: "warn", missing: result.missing });
      return;
    }
    for (const { name, unit, value } of result.figures) target.turn.addMetric(name, unit, value);
    for (const [key, value] of Object.entries(result.ids)) target.turn.addMetadata(key, value);
    for (const { name, code, value } of result.coded) {
      target.coded.addDimension(ERROR_CODE_DIMENSION, code);
      target.coded.addMetric(name, MetricUnit.Count, value);
      for (const [key, id] of Object.entries(result.ids)) target.coded.addMetadata(key, id);
      target.coded.publishStoredMetrics();
    }
  };
}

/** The `onConflictRetry` hook for `createDynamoRepositories`: one `BookingConflictRetries` per call (Q-6). */
export function conflictRetryCounter(metrics: Pick<Metrics, "addMetric">): () => void {
  return () => {
    metrics.addMetric(METRIC.bookingConflictRetries, MetricUnit.Count, 1);
  };
}
