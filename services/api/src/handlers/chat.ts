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
 *   throws or finds no record writes none (reporting those is #38's).
 */
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
import { consoleLogger } from "../lib/log";

/** The stored error text of a failed send starts with this; the notifier has already recorded it. */
const SEND_ERROR_PREFIX = `${new NotificationSendError("").name}:`;
/** The metric's `errorName` when no notifier is configured. */
const NO_NOTIFIER_ERROR_NAME = "NotifierNotConfigured";

/** The error's name from a stored notification error (`name: message`), or `UnknownError`. */
function errorNameOf(errorText: string): string {
  return /^([A-Za-z_$][\w$]*): /.exec(errorText)?.[1] ?? "UnknownError";
}

/** `repos` whose `escalations.updateNotification` reports each stored FAILED the notifier hasn't reported. */
function withNotificationFailedMetric(
  repos: Repositories,
  options: { hasNotifier: boolean; report: (failure: NotificationFailure) => void },
): Repositories {
  // Both repo implementations are plain objects of closures, so a spread copy keeps working.
  const escalations = repos.escalations;
  return {
    ...repos,
    escalations: {
      ...escalations,
      async updateNotification(patientId, conversationId, notification) {
        const updated = await escalations.updateNotification(patientId, conversationId, notification);
        const error = notification.error ?? "";
        if (updated && notification.status === "FAILED" && !error.startsWith(SEND_ERROR_PREFIX)) {
          options.report({
            escalationId: updated.escalationId,
            conversationId: updated.conversationId,
            errorName: options.hasNotifier ? errorNameOf(error) : NO_NOTIFIER_ERROR_NAME,
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
const notifier = sesNotifierFromEnv(process.env, undefined, clock);
const stores = createAwsStores({ tableName: config.tableName, clock });
const repos = withNotificationFailedMetric(stores.repos, {
  hasNotifier: notifier !== undefined,
  report: emfFailureReporter(schedEnv, clock),
});

export const handler = awslambda.streamifyResponse(
  chatStreamHandler({
    repos,
    turns: stores.turns,
    // Interactive chat: the SDK's default 3 attempts (with backoff) are the retry budget.
    llm: new ConverseLlmClient(),
    profile: config.profile,
    clock,
    systemPrompt: buildSystemPrompt,
    ...(notifier ? { notifier } : {}),
    dailyTurnCap: config.dailyTurnCap,
    log: consoleLogger,
  }),
);
