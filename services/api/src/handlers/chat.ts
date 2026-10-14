/**
 * `POST /api/chat` (S3-03, #17; wired end to end by #36). Lambda entry point, bundled by
 * services/api/Makefile into `index.mjs` (infra/stacks/api.yaml, `ChatFunction`).
 *
 * Everything expensive is created once per execution environment: config, the model profile, the
 * Converse client, the DynamoDB stores and the SES notifier. Each request then gets its own tool executor,
 * bound to the authorizer's `claims.sub` (see `lib/chat-turn.ts`).
 *
 * - The system prompt is `buildSystemPrompt` from `@sched/agent` (#16): the current version, recorded in
 *   every turn trace as `promptVersion`.
 * - The staff notifier is `sesNotifierFromEnv` (#35). With neither SES address set there is none, and
 *   escalations are recorded FAILED with the front-desk number still given to the patient (#23). A
 *   half-set SES environment fails the cold start.
 * - Failed-notification metric (#36, owner decision r1/Q-1 (a)): exactly one `Sched/NotificationFailed`
 *   EMF record per escalation whose notification is stored FAILED. The SES notifier writes the record for
 *   a failed send (`NotificationSendError`); this handler writes it for every other FAILED (no notifier, a
 *   profile or transcript read that throws, a notice that can't be built or rendered), by decorating
 *   `escalations.updateNotification`. The record is written once the FAILED status is stored; a write that
 *   throws or finds no record writes none.
 * - Failed status write (#38, assumption A-2): when `updateNotification` throws or finds no escalation, the
 *   wrapper logs one `"notification status write failed"` error entry (the conversation ID, the attempted
 *   status and, for a throw, `errorSummary`; IDs only) and then rethrows or returns the `null`, so the tool
 *   still swallows it. The line's Lambda request ID joins it to its turn. The record's `errorName` is read from
 *   the stored `name: message` text (owner decision c0dcd27/SPEC-1 (a)), so a non-`Error` rejection whose
 *   text has that shape is recorded under its first word, and a name that isn't an identifier is recorded
 *   as `UnknownError`.
 * - Observability (#38, NFR-007): log lines go through a Powertools Logger (`lib/observability/logger.ts`);
 *   the `"chat turn"` entry also writes the turn's metrics (`withTurnMetrics`); `book` and `reschedule`
 *   conflict retries count as `BookingConflictRetries`; the handler wrapper adds the Lambda context to the
 *   log lines and flushes the metrics once per invocation (`lib/observability/lambda.ts`). X-Ray
 *   (`Tracing: Active` on this function only, owner decision r1/Q-5 (a)) captures the Bedrock, DynamoDB
 *   and SES clients, with no HTTPS capture, no method decorators and no response or error capture.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { ConverseLlmClient, buildSystemPrompt } from "@sched/agent";
import { SystemClock, type Repositories } from "@sched/tools";
import {
  NotificationSendError,
  emfFailureReporter,
  sesNotifierFromEnv,
  type NotificationFailure,
} from "@sched/tools/ses";

import { createAwsStores } from "../lib/aws";
import { chatConfigFromEnv } from "../lib/config";
import { requireEnv } from "../lib/env";
import { chatStreamHandler } from "../lib/lambda";
import { errorSummary, type Logger } from "../lib/log";
import { instrumentStreamHandler } from "../lib/observability/lambda";
import { createPowertoolsLogger, powertoolsLogger } from "../lib/observability/logger";
import { conflictRetryCounter, envMetrics, withTurnMetrics } from "../lib/observability/metrics";

/** The stored error text of a failed send starts with this; the notifier has already recorded it. */
const SEND_ERROR_PREFIX = `${new NotificationSendError("").name}:`;
/** The metric's `errorName` when no notifier is configured. */
const NO_NOTIFIER_ERROR_NAME = "NotifierNotConfigured";

/** The error's name from a stored notification error (`name: message`), or `UnknownError`. */
function errorNameFromStoredText(errorText: string): string {
  return /^([A-Za-z_$][\w$]*): /.exec(errorText)?.[1] ?? "UnknownError";
}

/** The error entry for a status write that threw or found no escalation (A-2). IDs only. */
const STATUS_WRITE_FAILED = "notification status write failed";

/**
 * `repos` whose `escalations.updateNotification` reports each stored FAILED the notifier hasn't reported,
 * and logs each status write that throws or finds no escalation.
 */
function withNotificationFailedMetric(
  repos: Repositories,
  options: { hasNotifier: boolean; report: (failure: NotificationFailure) => void; log: Logger },
): Repositories {
  const escalations = repos.escalations;
  return {
    ...repos,
    escalations: {
      // Bound references, not a spread: they work for any `EscalationRepo`, a class instance included.
      record: escalations.record.bind(escalations),
      getForConversation: escalations.getForConversation.bind(escalations),
      async updateNotification(patientId, conversationId, notification) {
        const entry = {
          msg: STATUS_WRITE_FAILED,
          level: "error",
          conversationId,
          notificationStatus: notification.status,
        } as const;
        let updated: Awaited<ReturnType<typeof escalations.updateNotification>>;
        try {
          updated = await escalations.updateNotification(patientId, conversationId, notification);
        } catch (error) {
          options.log({ ...entry, ...errorSummary(error) });
          throw error;
        }
        if (!updated) options.log(entry);
        const error = notification.error ?? "";
        if (updated && notification.status === "FAILED" && !error.startsWith(SEND_ERROR_PREFIX)) {
          options.report({
            escalationId: updated.escalationId,
            conversationId: updated.conversationId,
            errorName: options.hasNotifier ? errorNameFromStoredText(error) : NO_NOTIFIER_ERROR_NAME,
          });
        }
        return updated;
      },
    },
  };
}

const config = chatConfigFromEnv();
const clock = new SystemClock();
const schedEnv = requireEnv(process.env, "SCHED_ENV");
const logger = createPowertoolsLogger("chat");
/** The `Env` store: each turn's figures and conflict retries, flushed once per invocation. */
const metrics = envMetrics(schedEnv);
const log = withTurnMetrics(powertoolsLogger(logger), { turn: metrics, coded: envMetrics(schedEnv) });
const tracer = new Tracer({ serviceName: "chat", captureHTTPsRequests: false });
const notifier = sesNotifierFromEnv(process.env, tracer.captureAWSv3Client(new SESv2Client({})), clock);
const stores = createAwsStores({
  tableName: config.tableName,
  clock,
  client: tracer.captureAWSv3Client(new DynamoDBClient({})),
  onConflictRetry: conflictRetryCounter(metrics),
});
const repos = withNotificationFailedMetric(stores.repos, {
  hasNotifier: notifier !== undefined,
  report: emfFailureReporter(schedEnv, clock),
  log,
});

export const handler = awslambda.streamifyResponse(
  instrumentStreamHandler(
    chatStreamHandler({
      repos,
      turns: stores.turns,
      // Interactive chat: the SDK's default 3 attempts (with backoff) are the retry budget.
      llm: new ConverseLlmClient({ client: tracer.captureAWSv3Client(new BedrockRuntimeClient({})) }),
      profile: config.profile,
      clock,
      systemPrompt: buildSystemPrompt,
      ...(notifier ? { notifier } : {}),
      dailyTurnCap: config.dailyTurnCap,
      log,
    }),
    { logger, metrics },
  ),
);
