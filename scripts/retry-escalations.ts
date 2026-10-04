/**
 * Re-send escalation emails that never reached staff (#35, FR-034, PRD §5).
 *
 *   npx tsx scripts/retry-escalations.ts <env> [--dry-run] [--min-pending-age <minutes>] [--table <name>] [--env-file <path>]
 *
 * `escalate_to_human` notifies staff once and never re-sends (PR #68, decision SPEC-3 (c)). An escalation
 * whose notification is `FAILED` (the send threw, or no notifier was configured) or stuck at `PENDING` (the
 * status update after the send failed, or the function died mid-turn) is re-sent from here:
 *
 * 1. Find: one Scan of the table for escalation items with those statuses (fine at this scale). A `PENDING`
 *    one is taken only once it is `--min-pending-age` minutes old (default 10), so a turn that is still
 *    notifying is left alone. `FAILED` ones are always taken.
 * 2. Rebuild: the notice from the stored escalation, the patient's profile and the conversation's messages
 *    as stored now, with the tool's own load-and-send step (`sendEscalationNotice`). Messages expire after
 *    30 days, so an old escalation may go out with an empty transcript.
 * 3. Re-send through the SES notifier, then set the notification to `SENT` with the new MessageId, or to
 *    `FAILED` with the (address-redacted) error. Each escalation is handled on its own; one failure does
 *    not stop the rest. Exit code 1 if any failed.
 *
 * Output is ids and statuses only (ADR-009). `--dry-run` lists what would be re-sent and sends nothing.
 * Two runs at once could both send the same escalation; run one at a time.
 *
 * Config: the table from SSM `/sched/<env>/data/table-name` (or `--table`); the sender and recipient from
 * `SES_SENDER` / `SES_STAFF_RECIPIENT`, loaded from the git-ignored `.env` (`--env-file`, default the repo's
 * `.env`) unless already set. Runs as the `sched-dev` SSO profile (AWS_PROFILE / AWS_REGION, defaults
 * `sched-dev` / `us-east-1`). With `DYNAMODB_ENDPOINT` set (DynamoDB Local), `--table` is required.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { type DynamoDBDocumentClient, paginateScan } from "@aws-sdk/lib-dynamodb";
import type { Escalation } from "@sched/contracts";
import {
  notificationErrorText,
  sendEscalationNotice,
  type Notifier,
  type Repositories,
  SystemClock,
} from "@sched/tools";
import { createDocumentClient, createDynamoRepositories, escalationFrom } from "@sched/tools/dynamo";
import { SesNotifier } from "@sched/tools/ses";

import { dynamoClientFor, ssmClientFor, ssmParamFrom } from "./seed-data";

// Copied from scripts/seed-data.ts, which doesn't export it.
const ENV_PATTERN = /^[a-z][a-z0-9-]{1,15}$/;
export const DEFAULT_MIN_PENDING_AGE_MINUTES = 10;

// ---------------------------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------------------------

/**
 * The escalations to re-send, oldest first: every `FAILED` one, and each `PENDING` one created at least
 * `minPendingAgeMs` before `now`.
 */
export async function findUnsentEscalations(
  doc: DynamoDBDocumentClient,
  tableName: string,
  options: {
    now: Date;
    minPendingAgeMs: number;
    /** Items read per Scan page (DynamoDB `Limit`); the default is DynamoDB's (up to 1 MB). */
    pageSize?: number;
  },
): Promise<Escalation[]> {
  const found: Escalation[] = [];
  const pages = paginateScan(
    { client: doc, pageSize: options.pageSize },
    {
      TableName: tableName,
      ConsistentRead: true,
      FilterExpression: "entityType = :esc AND notification.#status IN (:failed, :pending)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":esc": "ESCALATION", ":failed": "FAILED", ":pending": "PENDING" },
    },
  );
  const pendingBefore = options.now.getTime() - options.minPendingAgeMs;
  for await (const page of pages) {
    for (const item of page.Items ?? []) {
      const escalation = escalationFrom(item);
      if (escalation.notification.status === "PENDING" && Date.parse(escalation.createdAt) > pendingBefore)
        continue;
      found.push(escalation);
    }
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------------------------
// Re-send
// ---------------------------------------------------------------------------------------------

export interface RetryOutcome {
  escalationId: string;
  conversationId: string;
  /** The status before this run. */
  was: "FAILED" | "PENDING";
  status: "SENT" | "FAILED";
  messageId?: string;
  error?: string;
}

/** Rebuild the notice for `escalation`, send it, and record the result on the escalation. */
export async function retryEscalation(
  escalation: Escalation,
  deps: { repos: Repositories; notifier: Notifier },
): Promise<RetryOutcome> {
  const { patientId, conversationId, escalationId } = escalation;
  const was = escalation.notification.status === "PENDING" ? "PENDING" : "FAILED";
  const notification = await sendEscalationNotice(escalation, patientId, deps);
  const outcome: RetryOutcome = { escalationId, conversationId, was, ...notification };
  try {
    const updated = await deps.repos.escalations.updateNotification(patientId, conversationId, notification);
    if (!updated) throw new Error("the escalation record is gone");
  } catch (error) {
    // Sent but not recorded: the next run would send it again, so say so loudly.
    return {
      ...outcome,
      error: `${outcome.error ? `${outcome.error}; ` : ""}status not recorded (${notificationErrorText(error)})`,
    };
  }
  return outcome;
}

export interface RetrySummary {
  found: number;
  sent: number;
  failed: number;
  outcomes: RetryOutcome[];
}

export async function retryEscalations(options: {
  doc: DynamoDBDocumentClient;
  repos: Repositories;
  tableName: string;
  /** Absent in a dry run. */
  notifier: Notifier | undefined;
  now: Date;
  minPendingAgeMs: number;
  log: (line: string) => void;
}): Promise<RetrySummary> {
  const { doc, repos, tableName, notifier, now, minPendingAgeMs, log } = options;
  const found = await findUnsentEscalations(doc, tableName, { now, minPendingAgeMs });
  log(`${String(found.length)} escalation(s) to re-send`);
  const outcomes: RetryOutcome[] = [];
  for (const escalation of found) {
    const { escalationId, conversationId, notification } = escalation;
    if (!notifier) {
      log(`would re-send ${escalationId} (conversation ${conversationId}, ${notification.status})`);
      continue;
    }
    const outcome = await retryEscalation(escalation, { repos, notifier });
    outcomes.push(outcome);
    log(
      `${escalationId} (conversation ${conversationId}): ${outcome.was} -> ${outcome.status}` +
        (outcome.messageId ? `, MessageId ${outcome.messageId}` : "") +
        (outcome.error ? `, ${outcome.error}` : ""),
    );
  }
  // Sent and recorded. A FAILED outcome always has an error; a SENT one has one only if it went unrecorded.
  const sent = outcomes.filter((o) => !o.error).length;
  return { found: found.length, sent, failed: outcomes.length - sent, outcomes };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: retry-escalations.ts <env> [--dry-run] [--min-pending-age <minutes>] [--table <name>] [--env-file <path>]";

export interface CliArgs {
  env: string;
  dryRun: boolean;
  minPendingAgeMinutes: number;
  table?: string;
  envFile: string;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean", default: false },
      "min-pending-age": { type: "string" },
      table: { type: "string" },
      "env-file": { type: "string", default: join(repoRoot, ".env") },
    },
  });
  const [env, ...rest] = positionals;
  if (env === undefined) throw new Error(USAGE);
  if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(" ")}`);
  if (!ENV_PATTERN.test(env)) throw new Error(`invalid env: ${env}`);
  const age = values["min-pending-age"];
  if (age !== undefined && !/^\d+$/.test(age))
    throw new Error(`--min-pending-age must be whole minutes, got ${age}`);
  const minPendingAgeMinutes = age === undefined ? DEFAULT_MIN_PENDING_AGE_MINUTES : Number(age);
  return {
    env,
    dryRun: values["dry-run"],
    minPendingAgeMinutes,
    table: values.table,
    envFile: values["env-file"],
  };
}

export interface CliDeps {
  now?: Date;
  ssmClient?: (region: string) => Pick<SSMClient, "send">;
  dynamoClient?: typeof dynamoClientFor;
  /** The SES notifier for `region` (default: `sesNotifierFor`). */
  notifier?: (region: string, sender: string, recipient: string) => Notifier;
  log?: (line: string) => void;
  /** Where `main` reports an error that stopped the run (default: `console.error`). */
  logError?: (line: string) => void;
}

/**
 * The script's SES notifier: SES v2 in `region`, with no failure metric (this script reports each failure
 * itself, and its runs are not the chat function's). `client` is for tests.
 */
export function sesNotifierFor(
  region: string,
  sender: string,
  recipient: string,
  client: Pick<SESv2Client, "send"> = new SESv2Client({ region }),
): Notifier {
  return new SesNotifier({ client, sender, recipient, onFailure: () => undefined });
}

/** The CLI after parsing. `vars` is the process environment, with the `.env` file already loaded. */
export async function runCli(
  args: CliArgs,
  vars: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<RetrySummary> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const endpoint = vars.DYNAMODB_ENDPOINT;
  const region = vars.AWS_REGION ?? "us-east-1";

  let notifier: Notifier | undefined;
  if (!args.dryRun) {
    const sender = vars.SES_SENDER;
    const recipient = vars.SES_STAFF_RECIPIENT;
    if (!sender || !recipient) {
      throw new Error(
        `Set SES_SENDER and SES_STAFF_RECIPIENT (in ${args.envFile}) to re-send, or pass --dry-run`,
      );
    }
    notifier = (deps.notifier ?? sesNotifierFor)(region, sender, recipient);
  }

  let tableName: string;
  if (endpoint) {
    if (!args.table) throw new Error("DYNAMODB_ENDPOINT is set: pass --table <name> for the local table");
    tableName = args.table;
  } else {
    tableName =
      args.table ??
      (await ssmParamFrom((deps.ssmClient ?? ssmClientFor)(region))(args.env, "data/table-name"));
  }

  const client = (deps.dynamoClient ?? dynamoClientFor)(region, endpoint);
  log(
    `Re-sending escalation emails in env '${args.env}' table ${tableName}${args.dryRun ? " (dry run)" : ""}`,
  );
  try {
    const summary = await retryEscalations({
      doc: createDocumentClient(client),
      repos: createDynamoRepositories({ tableName, client, clock: new SystemClock() }),
      tableName,
      notifier,
      now: deps.now ?? new Date(),
      minPendingAgeMs: args.minPendingAgeMinutes * 60_000,
      log: (line) => log(`  ${line}`),
    });
    if (!args.dryRun) log(`Done: ${String(summary.sent)} sent, ${String(summary.failed)} failed`);
    return summary;
  } finally {
    client.destroy();
  }
}

/**
 * The script's entry point; returns the exit code: 1 if the run stopped on an error or any re-send failed.
 *
 * `vars` is the process environment, and is changed in place: `AWS_PROFILE` defaults to `sched-dev`, and
 * the `--env-file` (default `<repo root>/.env`) is loaded into it if it exists. Values already set win, as
 * with `process.loadEnvFile`.
 */
export async function main(
  argv: readonly string[],
  vars: Record<string, string | undefined>,
  deps: CliDeps = {},
): Promise<number> {
  vars.AWS_PROFILE ??= "sched-dev";
  try {
    const args = parseCliArgs(argv);
    if (existsSync(args.envFile)) {
      for (const [key, value] of Object.entries(parseEnv(readFileSync(args.envFile, "utf8"))))
        vars[key] ??= value;
    }
    const summary = await runCli(args, vars, deps);
    return summary.failed > 0 ? 1 : 0;
  } catch (err) {
    (deps.logError ?? ((line: string) => console.error(line)))(
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
