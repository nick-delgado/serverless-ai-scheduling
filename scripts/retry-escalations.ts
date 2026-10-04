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
 * 2. Rebuild: the notice from the stored escalation, the patient's profile and the conversation's messages,
 *    with the same builder as the tool (`buildEscalationNotice`). Messages expire after 30 days, so an old
 *    escalation may go out with an empty transcript.
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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { type DynamoDBDocumentClient, paginateScan } from "@aws-sdk/lib-dynamodb";
import { Escalation } from "@sched/contracts";
import { buildEscalationNotice, type Notifier, type Repositories, SystemClock } from "@sched/tools";
import { createDocumentClient, createDynamoRepositories } from "@sched/tools/dynamo";
import { SesNotifier } from "@sched/tools/ses";

import { dynamoClientFor, ssmClientFor, ssmParamFrom } from "./seed-data";

const ENV_PATTERN = /^[a-z][a-z0-9-]{1,15}$/;
/** As in escalate_to_human: the stored error is at most 500 characters. */
const MAX_ERROR = 500;
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
  options: { now: Date; minPendingAgeMs: number },
): Promise<Escalation[]> {
  const found: Escalation[] = [];
  const pages = paginateScan(
    { client: doc },
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
      const { PK: _pk, SK: _sk, entityType: _type, ...fields } = item;
      const escalation = Escalation.parse(fields);
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

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR);
};

/** Rebuild the notice for `escalation`, send it, and record the result on the escalation. */
export async function retryEscalation(
  escalation: Escalation,
  deps: { repos: Repositories; notifier: Notifier },
): Promise<RetryOutcome> {
  const { patientId, conversationId, escalationId } = escalation;
  const was = escalation.notification.status === "PENDING" ? "PENDING" : "FAILED";
  let notification: { status: "SENT"; messageId: string } | { status: "FAILED"; error: string };
  try {
    const [patient, messages] = await Promise.all([
      deps.repos.patients.get(patientId),
      deps.repos.conversations.listMessages(patientId, conversationId),
    ]);
    const { messageId } = await deps.notifier.notifyEscalation(
      buildEscalationNotice(escalation, patient, messages),
    );
    notification = { status: "SENT", messageId };
  } catch (error) {
    notification = { status: "FAILED", error: errorText(error) };
  }
  const outcome: RetryOutcome = { escalationId, conversationId, was, ...notification };
  try {
    const updated = await deps.repos.escalations.updateNotification(patientId, conversationId, notification);
    if (!updated) throw new Error("the escalation record is gone");
  } catch (error) {
    // Sent but not recorded: the next run would send it again, so say so loudly.
    return {
      ...outcome,
      error: `${outcome.error ? `${outcome.error}; ` : ""}status not recorded (${errorText(error)})`,
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
  if (env === undefined)
    throw new Error("usage: retry-escalations.ts <env> [--dry-run] [--min-pending-age <minutes>]");
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
  /** The SES notifier for `region` (default: SES v2 with no failure metric; this script reports failures itself). */
  notifier?: (region: string, sender: string, recipient: string) => Notifier;
  log?: (line: string) => void;
}

function sesNotifierFor(region: string, sender: string, recipient: string): Notifier {
  return new SesNotifier({
    client: new SESv2Client({ region }),
    sender,
    recipient,
    onFailure: () => undefined,
  });
}

/** The CLI. `vars` is the process environment, with the `.env` file already loaded. */
export async function runCli(
  argv: readonly string[],
  vars: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<RetrySummary> {
  const args = parseCliArgs(argv);
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

if (import.meta.main) {
  process.env.AWS_PROFILE ??= "sched-dev";
  const envFile = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: { "env-file": { type: "string", default: join(repoRoot, ".env") } },
  }).values["env-file"];
  if (typeof envFile === "string" && existsSync(envFile)) process.loadEnvFile(envFile);
  runCli(process.argv.slice(2), process.env)
    .then((summary) => {
      if (summary.failed > 0) process.exitCode = 1;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
