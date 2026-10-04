/**
 * The SES `Notifier` (#35, FR-034): emails an escalation to front-desk staff through SES v2 `SendEmail`.
 *
 * A separate entry point (`@sched/tools/ses`), like `@sched/tools/dynamo`, so the in-memory and eval import
 * graph never loads the SES SDK.
 *
 * - Sender and recipient are deploy-time configuration (`SES_SENDER`, `SES_STAFF_RECIPIENT` on the chat
 *   function, from `scripts/deploy.sh`), never notice content and never a committed file. In the SES
 *   sandbox both must be verified identities.
 * - `notifyEscalation` returns the SES `MessageId` and throws `NotificationSendError` on any failure, so
 *   the tool records FAILED. Its message names the SES error with every email address redacted: it is
 *   stored on the escalation and printed by the retry script.
 * - Every failure is reported once through `onFailure`. The default writes a CloudWatch embedded-metric
 *   (EMF) line for `Sched/NotificationFailed` (ids and the error name only, no message text, ADR-009),
 *   which the `NotificationFailedAlarm` in `infra/stacks/api.yaml` watches.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

import type { EscalationNotice, Notifier, NotifyResult } from "./index";
import { renderEscalationEmail } from "./render";

/** The failed-notification metric. `infra/stacks/api.yaml` (alarm) and #38's dashboard use these names. */
export const NOTIFICATION_FAILED_METRIC = {
  namespace: "Sched",
  name: "NotificationFailed",
  dimension: "Env",
} as const;

export interface NotificationFailure {
  escalationId: string;
  conversationId: string;
  /** The underlying error's `name`, e.g. `MessageRejected`. Never its message. */
  errorName: string;
}

/** Thrown by `SesNotifier.notifyEscalation`; the SES error is its `cause`. */
export class NotificationSendError extends Error {
  override readonly name = "NotificationSendError";
}

const EMAIL_ADDRESS = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+/g;

/** `text` with every email address replaced by `<address>`. */
export function redactAddresses(text: string): string {
  return text.replace(EMAIL_ADDRESS, "<address>");
}

/** One CloudWatch EMF log line recording a failed notification in env `env`. */
export function notificationFailedEmf(env: string, failure: NotificationFailure, now: Date): string {
  const { namespace, name, dimension } = NOTIFICATION_FAILED_METRIC;
  return JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [
        { Namespace: namespace, Dimensions: [[dimension]], Metrics: [{ Name: name, Unit: "Count" }] },
      ],
    },
    [dimension]: env,
    [name]: 1,
    escalationId: failure.escalationId,
    conversationId: failure.conversationId,
    errorName: failure.errorName,
  });
}

/**
 * Writes the EMF line straight to stdout. Lambda's JSON log format wraps `console.*` output in its own
 * record, which CloudWatch would not read as EMF; a raw stdout line is passed through as it is.
 */
export function emfFailureReporter(env: string): (failure: NotificationFailure) => void {
  return (failure) => {
    process.stdout.write(`${notificationFailedEmf(env, failure, new Date())}\n`);
  };
}

export interface SesNotifierOptions {
  client: Pick<SESv2Client, "send">;
  /** The verified SES identity the email comes from. */
  sender: string;
  /** The front-desk address (a verified identity while SES is in the sandbox). */
  recipient: string;
  /** Called once per failed send, before the throw. If it throws, the send error is still the one thrown. */
  onFailure: (failure: NotificationFailure) => void;
}

export class SesNotifier implements Notifier {
  constructor(private readonly options: SesNotifierOptions) {
    if (!options.sender || !options.recipient) throw new Error("SesNotifier needs a sender and a recipient");
  }

  async notifyEscalation(notice: EscalationNotice): Promise<NotifyResult> {
    const { subject, text, html } = renderEscalationEmail(notice);
    let messageId: string | undefined;
    try {
      const out = await this.options.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.options.sender,
          Destination: { ToAddresses: [this.options.recipient] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: "UTF-8" },
              Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
            },
          },
        }),
      );
      messageId = out.MessageId;
    } catch (error) {
      throw this.failed(notice, error);
    }
    if (!messageId) throw this.failed(notice, new Error("SES returned no MessageId"));
    return { messageId };
  }

  private failed(notice: EscalationNotice, error: unknown): NotificationSendError {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const detail = error instanceof Error ? error.message : String(error);
    try {
      this.options.onFailure({
        escalationId: notice.escalationId,
        conversationId: notice.conversationId,
        errorName,
      });
    } catch {
      // Reporting must never hide the send failure from the caller, which records FAILED.
    }
    return new NotificationSendError(redactAddresses(`${errorName}: ${detail}`), { cause: error });
  }
}

/**
 * The chat function's notifier, from its environment: `SES_SENDER`, `SES_STAFF_RECIPIENT` and `SCHED_ENV`
 * (the metric's `Env`). Undefined when SES is not configured for the env (both unset), so the tool records
 * FAILED; throws when only one of the two is set.
 */
export function sesNotifierFromEnv(
  vars: Readonly<Record<string, string | undefined>>,
  client?: Pick<SESv2Client, "send">,
): SesNotifier | undefined {
  const sender = vars.SES_SENDER;
  const recipient = vars.SES_STAFF_RECIPIENT;
  if (!sender && !recipient) return undefined;
  if (!sender || !recipient) throw new Error("Set both SES_SENDER and SES_STAFF_RECIPIENT, or neither");
  const env = vars.SCHED_ENV;
  if (!env) throw new Error("SCHED_ENV is not set");
  return new SesNotifier({
    client: client ?? new SESv2Client({}),
    sender,
    recipient,
    onFailure: emfFailureReporter(env),
  });
}
