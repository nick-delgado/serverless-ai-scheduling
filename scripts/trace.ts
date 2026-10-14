/**
 * Print a conversation's per-turn agent traces from DynamoDB (#38 AC8, FR-051, ADR-009).
 *
 *   npx tsx scripts/trace.ts <env> <conversationId> [--table <name>] [--json] [--inputs]
 *
 * The chat handler saves one `TurnTrace` per turn under `CONV#<conversationId>` / `TRACE#<turnId>`
 * (`services/api/src/lib/dynamo-turn-store.ts`). This script queries only those items, with
 * `begins_with(SK, "TRACE#")` and a projection that leaves out `patientId`, so the conversation's messages,
 * which share the partition, are never read. Turns print in `startedAt` order:
 *
 * - each turn: its ID, start time, outcome, model profile, prompt version, iterations, duration and usage;
 * - each model call: its index and attempt, model ID, stop reason, TTFT, duration and usage;
 * - each tool call: its name, ok, error code and duration.
 *
 * Output is IDs and figures only (ADR-009, decision r1/Q-7 (a) on #38). A tool call's input can carry
 * patient free text, so it prints only with `--inputs`; never paste that output into an issue or PR.
 * `--json` prints one JSON object per turn, with the same fields.
 *
 * Exit codes: 0 every trace printed; 1 no traces (an unknown conversation, expired traces after the 30-day
 * TTL and a conversation with none all look the same), an item whose `trace` isn't a `TurnTrace` (it prints
 * as unreadable, after the rest), or an error before printing. Replayed turns and turns whose trace save
 * failed have no trace and are simply absent.
 *
 * Config: the table from SSM `/sched/<env>/data/table-name` (or `--table`). Runs as the `sched-dev` SSO
 * profile (AWS_PROFILE / AWS_REGION, defaults `sched-dev` / `us-east-1`); it only reads. With
 * `DYNAMODB_ENDPOINT` set (DynamoDB Local), `--table` is required.
 */
import { parseArgs } from "node:util";

import type { SSMClient } from "@aws-sdk/client-ssm";
import { type DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { turnKeys } from "@sched/api/dynamo-turn-store";
import { ConversationId, TurnTrace, type TokenUsage } from "@sched/contracts";
import { createDocumentClient } from "@sched/tools/dynamo";

import { dynamoClientFor, ENV_PATTERN, ssmClientFor, ssmParamFrom } from "./seed-data";

const USAGE = "usage: trace.ts <env> <conversationId> [--table <name>] [--json] [--inputs]";

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

/** One stored trace item: the turn ID from its key, its `startedAt`, and the trace if it parsed. */
export interface TraceEntry {
  turnId: string;
  startedAt: string;
  trace?: TurnTrace;
}

/**
 * Every trace item under the conversation, sorted by `startedAt` (a stable sort; an item without one sorts
 * first). Pages through the query until DynamoDB returns no `LastEvaluatedKey`.
 */
export async function readTraces(
  doc: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  conversationId: ConversationId,
  options: { pageSize?: number } = {},
): Promise<TraceEntry[]> {
  // The key prefixes have one definition: the turn store's own `turnKeys`, with an empty turn ID.
  const { PK, SK: prefix } = turnKeys.trace(conversationId, "");
  const entries: TraceEntry[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": PK, ":prefix": prefix },
        // Never `patientId`: the script has no use for it, so it never leaves the table.
        ProjectionExpression: "SK, startedAt, #trace",
        ExpressionAttributeNames: { "#trace": "trace" },
        ExclusiveStartKey: startKey,
        Limit: options.pageSize,
      }),
    );
    for (const item of page.Items ?? []) entries.push(entryFrom(item, prefix));
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return entries.sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt));
}

function entryFrom(item: Record<string, unknown>, prefix: string): TraceEntry {
  const turnId = String(item.SK).slice(prefix.length);
  const stored = typeof item.startedAt === "string" ? item.startedAt : "";
  const trace = parseTrace(item.trace);
  return trace ? { turnId, startedAt: trace.startedAt, trace } : { turnId, startedAt: stored };
}

function parseTrace(raw: unknown): TurnTrace | undefined {
  if (typeof raw !== "string") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = TurnTrace.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Milliseconds since the epoch; an absent or unparseable time sorts first. */
function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? -Infinity : ms;
}

// ---------------------------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------------------------

/** The fields a turn prints, in `--json` and in text: IDs and figures, and tool inputs only on request. */
export function turnView(trace: TurnTrace, inputs: boolean) {
  return {
    turnId: trace.turnId,
    startedAt: trace.startedAt,
    outcome: trace.outcome,
    modelProfile: trace.modelProfile,
    promptVersion: trace.promptVersion,
    iterations: trace.iterations,
    durationMs: trace.durationMs,
    usage: trace.usage,
    llmCalls: trace.llmCalls.map((c) => ({
      index: c.index,
      attempt: c.attempt,
      modelId: c.modelId,
      stopReason: c.stopReason,
      providerStopReason: c.providerStopReason,
      ttftMs: c.ttftMs,
      durationMs: c.durationMs,
      usage: c.usage,
    })),
    toolCalls: trace.toolCalls.map((t) => ({
      name: t.name,
      ok: t.ok,
      errorCode: t.errorCode,
      durationMs: t.durationMs,
      ...(inputs ? { input: t.input } : {}),
    })),
  };
}

const usageText = (u: TokenUsage): string =>
  `in ${String(u.inputTokens)} out ${String(u.outputTokens)} ` +
  `cache read ${String(u.cacheReadTokens)} cache write ${String(u.cacheWriteTokens)}`;

/** The text lines for one turn. */
export function turnLines(trace: TurnTrace, inputs: boolean): string[] {
  const v = turnView(trace, inputs);
  const lines = [
    `turn ${v.turnId} ${v.startedAt} ${v.outcome}`,
    `  profile ${v.modelProfile}, prompt ${v.promptVersion}, ${String(v.iterations)} iterations, ` +
      `${String(v.durationMs)} ms, ${usageText(v.usage)}`,
  ];
  for (const c of v.llmCalls) {
    const stop = c.providerStopReason ? `${c.stopReason} (${c.providerStopReason})` : c.stopReason;
    const ttft = c.ttftMs === undefined ? "-" : `${String(c.ttftMs)} ms`;
    lines.push(
      `  model ${String(c.index)}.${String(c.attempt)} ${c.modelId} ${stop}, ttft ${ttft}, ` +
        `${String(c.durationMs)} ms, ${usageText(c.usage)}`,
    );
  }
  for (const t of v.toolCalls) {
    const status = t.ok ? "ok" : `failed ${t.errorCode ?? "-"}`;
    lines.push(`  tool ${t.name} ${status}, ${String(t.durationMs)} ms`);
    if ("input" in t) lines.push(`    input ${JSON.stringify(t.input)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface CliArgs {
  env: string;
  conversationId: ConversationId;
  table?: string;
  json: boolean;
  inputs: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      table: { type: "string" },
      json: { type: "boolean", default: false },
      inputs: { type: "boolean", default: false },
    },
  });
  const [env, conversationId, ...rest] = positionals;
  if (env === undefined || conversationId === undefined) throw new Error(USAGE);
  if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(" ")}`);
  if (!ENV_PATTERN.test(env)) throw new Error(`invalid env: ${env}`);
  if (!ConversationId.safeParse(conversationId).success)
    throw new Error(`invalid conversationId: ${conversationId}`);
  return { env, conversationId, table: values.table, json: values.json, inputs: values.inputs };
}

export interface CliDeps {
  ssmClient?: (region: string) => Pick<SSMClient, "send">;
  dynamoClient?: typeof dynamoClientFor;
  /** Where the traces go (default: `console.log`). */
  log?: (line: string) => void;
  /** Where "no traces", unreadable items and errors go (default: `console.error`). */
  logError?: (line: string) => void;
}

/** The CLI after parsing; returns the exit code. `vars` is the process environment. */
export async function runCli(
  args: CliArgs,
  vars: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  // The operator scripts' shared CLI shape: `retry-escalations.ts` and `seed-data.ts` resolve the table the same
  // way, and `retry-escalations.ts` ends in the same `main`. A helper for it is a refactor across `scripts/**`,
  // outside #38's paths.
  // jscpd:ignore-start
  const endpoint = vars.DYNAMODB_ENDPOINT || undefined;
  const region = vars.AWS_REGION ?? "us-east-1";

  let tableName: string;
  if (endpoint) {
    if (!args.table) throw new Error("DYNAMODB_ENDPOINT is set: pass --table <name> for the local table");
    tableName = args.table;
  } else {
    tableName =
      args.table ??
      (await ssmParamFrom((deps.ssmClient ?? ssmClientFor)(region))(args.env, "data/table-name"));
  }

  // jscpd:ignore-end
  const client = (deps.dynamoClient ?? dynamoClientFor)(region, endpoint);
  let entries: TraceEntry[];
  try {
    entries = await readTraces(createDocumentClient(client), tableName, args.conversationId);
  } finally {
    client.destroy();
  }

  if (entries.length === 0) {
    logError(`No traces for conversation ${args.conversationId} in table ${tableName}`);
    return 1;
  }
  let unreadable = 0;
  for (const entry of entries) {
    if (!entry.trace) {
      unreadable += 1;
      logError(`turn ${entry.turnId}: unreadable trace`);
    } else if (args.json) {
      log(JSON.stringify(turnView(entry.trace, args.inputs)));
    } else {
      for (const line of turnLines(entry.trace, args.inputs)) log(line);
    }
  }
  return unreadable > 0 ? 1 : 0;
}

// The same entry point as `retry-escalations.ts`'s (see the note in `runCli`).
// jscpd:ignore-start
/**
 * The script's entry point; returns the exit code. `vars` is the process environment, and is changed in
 * place: `AWS_PROFILE` defaults to `sched-dev`.
 */
export async function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: CliDeps = {},
): Promise<number> {
  vars.AWS_PROFILE ??= "sched-dev";
  try {
    return await runCli(parseCliArgs(argv), vars, deps);
  } catch (err) {
    (deps.logError ?? ((line: string) => console.error(line)))(
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }
}

/* v8 ignore next -- CLI entry: tests call main() in-process; a child process records no coverage */
if (import.meta.main) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
// jscpd:ignore-end
