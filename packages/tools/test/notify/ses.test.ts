import { readFileSync } from "node:fs";

import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FrozenClock } from "../../src/clock";
import { renderEscalationEmail } from "../../src/notify/render";
import {
  emfFailureReporter,
  NOTIFICATION_FAILED_METRIC,
  NotificationSendError,
  notificationFailedEmf,
  redactAddresses,
  SES_ENV,
  SesNotifier,
  sesNotifierFromEnv,
  type NotificationFailure,
} from "../../src/notify/ses";
import { NOTICE } from "./fixtures";

// Placeholder addresses on the reserved example.com domain; real ones come from deploy-time config.
const SENDER = "clinic-sender@example.com";
const RECIPIENT = "front-desk@example.com";

type Send = SESv2Client["send"];

function fakeClient(impl: () => Promise<unknown>) {
  const send = vi.fn(impl);
  return { client: { send: send as unknown as Send }, send };
}

function notifier(impl: () => Promise<unknown>) {
  const { client, send } = fakeClient(impl);
  const failures: NotificationFailure[] = [];
  const n = new SesNotifier({
    client,
    sender: SENDER,
    recipient: RECIPIENT,
    onFailure: (f) => failures.push(f),
  });
  return { n, send, failures };
}

const sentInput = (send: ReturnType<typeof vi.fn>) => {
  expect(send).toHaveBeenCalledTimes(1);
  const command = send.mock.calls[0]?.[0] as unknown;
  expect(command).toBeInstanceOf(SendEmailCommand);
  return (command as SendEmailCommand).input;
};

describe("SesNotifier", () => {
  it("sends the rendered email from the sender to the recipient and returns the MessageId", async () => {
    const { n, send, failures } = notifier(() => Promise.resolve({ MessageId: "ses-msg-1" }));

    await expect(n.notifyEscalation(NOTICE)).resolves.toEqual({ messageId: "ses-msg-1" });

    const { subject, text, html } = renderEscalationEmail(NOTICE);
    expect(sentInput(send)).toEqual({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [RECIPIENT] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
        },
      },
    });
    expect(failures).toEqual([]);
  });

  it("throws a NotificationSendError naming the SES error, with addresses redacted, and reports the failure", async () => {
    const sesError = Object.assign(
      new Error(`Email address is not verified. The following identities failed the check: ${RECIPIENT}`),
      { name: "MessageRejected" },
    );
    const { n, failures } = notifier(() => Promise.reject(sesError));

    const thrown = await n.notifyEscalation(NOTICE).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(NotificationSendError);
    const err = thrown as NotificationSendError;
    expect(err.name).toBe("NotificationSendError");
    expect(err.message).toBe(
      "MessageRejected: Email address is not verified. The following identities failed the check: <address>",
    );
    expect(err.cause).toBe(sesError);
    expect(failures).toEqual([
      {
        escalationId: NOTICE.escalationId,
        conversationId: NOTICE.conversationId,
        errorName: "MessageRejected",
      },
    ]);
  });

  it("treats a response without a MessageId as a failure", async () => {
    const { n, failures } = notifier(() => Promise.resolve({}));
    await expect(n.notifyEscalation(NOTICE)).rejects.toThrow(
      new NotificationSendError("Error: SES returned no MessageId"),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.errorName).toBe("Error");
  });

  it("reports a non-Error rejection as UnknownError", async () => {
    const { n, failures } = notifier(() => Promise.reject("socket closed"));
    await expect(n.notifyEscalation(NOTICE)).rejects.toThrow("UnknownError: socket closed");
    expect(failures[0]?.errorName).toBe("UnknownError");
  });

  it("still throws the send error when the failure reporter throws", async () => {
    const { client } = fakeClient(() => Promise.reject(new Error("throttled")));
    const n = new SesNotifier({
      client,
      sender: SENDER,
      recipient: RECIPIENT,
      onFailure: () => {
        throw new Error("stdout closed");
      },
    });
    await expect(n.notifyEscalation(NOTICE)).rejects.toThrow(new NotificationSendError("Error: throttled"));
  });

  it.each([
    ["sender", { sender: "" }],
    ["recipient", { recipient: "" }],
  ])("refuses an empty %s", (_name, override) => {
    const { client } = fakeClient(() => Promise.resolve({}));
    expect(
      () =>
        new SesNotifier({
          client,
          sender: SENDER,
          recipient: RECIPIENT,
          onFailure: () => undefined,
          ...override,
        }),
    ).toThrow("SesNotifier needs a sender and a recipient");
  });
});

describe("redactAddresses", () => {
  it("replaces every email address", () => {
    expect(redactAddresses(`from ${SENDER} to <${RECIPIENT}>, "a.b+c@sub.example.org".`)).toBe(
      'from <address> to <<address>>, "<address>".',
    );
  });
});

describe("failed-notification metric", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failure: NotificationFailure = {
    escalationId: NOTICE.escalationId,
    conversationId: NOTICE.conversationId,
    errorName: "MessageRejected",
  };

  it("is an EMF record of Sched/NotificationFailed = 1 for the env, with ids and the error name only", () => {
    const now = new Date("2026-10-05T13:00:00Z");
    expect(JSON.parse(notificationFailedEmf("dev", failure, now))).toEqual({
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: "Sched",
            Dimensions: [["Env"]],
            Metrics: [{ Name: "NotificationFailed", Unit: "Count" }],
          },
        ],
      },
      Env: "dev",
      NotificationFailed: 1,
      escalationId: failure.escalationId,
      conversationId: failure.conversationId,
      errorName: "MessageRejected",
    });
  });

  it("is written to stdout as one raw line, stamped by the clock", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const at = new Date("2026-10-05T14:30:00Z");
    emfFailureReporter("pr52", new FrozenClock(at))(failure);
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("}\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      _aws: { Timestamp: at.getTime() },
      Env: "pr52",
      NotificationFailed: 1,
      errorName: "MessageRejected",
    });
  });
});

describe("infra/stacks/api.yaml", () => {
  const template = readFileSync(new URL("../../../../infra/stacks/api.yaml", import.meta.url), "utf8");
  /** The lines of the top-level-indented block that starts with `header`, up to the next one at its indent. */
  const block = (header: string, indent: number): string => {
    const pad = " ".repeat(indent);
    const re = new RegExp(`^${pad}${header}\n(?:(?:${pad} .*)?\n)+`, "m");
    return re.exec(template)?.[0] ?? "";
  };

  it("has an alarm on the failed-notification metric that fires on one failure in the env", () => {
    const alarm = block("NotificationFailedAlarm:", 2);
    expect(alarm).toContain(`Namespace: ${NOTIFICATION_FAILED_METRIC.namespace}\n`);
    expect(alarm).toContain(`MetricName: ${NOTIFICATION_FAILED_METRIC.name}\n`);
    expect(alarm).toContain(
      `Dimensions:\n        - Name: ${NOTIFICATION_FAILED_METRIC.dimension}\n          Value: !Ref Env\n`,
    );
    expect(alarm).toContain("Statistic: Sum\n");
    expect(alarm).toContain("Threshold: 1\n");
    expect(alarm).toContain("ComparisonOperator: GreaterThanOrEqualToThreshold\n");
  });

  it("gives every function the env the metric's dimension is read from", () => {
    expect(block("Globals:", 0)).toContain(
      "    Environment:\n      Variables:\n        SCHED_ENV: !Ref Env\n",
    );
  });

  it("passes the SES addresses to the chat function under the names sesNotifierFromEnv reads", () => {
    const chat = block("ChatFunction:", 2);
    expect(chat).toContain(
      `          ${SES_ENV.sender}: !If [SesConfigured, !Ref SesSender, !Ref AWS::NoValue]\n`,
    );
    expect(chat).toContain(
      `          ${SES_ENV.recipient}: !If [SesConfigured, !Ref SesStaffRecipient, !Ref AWS::NoValue]\n`,
    );
  });

  it("lets the chat function send only from the sender identity", () => {
    const chat = block("ChatFunction:", 2);
    const grant = /^ {14}- Sid: SendEscalationEmail\n(?: {16}.*\n)+/m.exec(chat)?.[0];
    const identity = "arn:${AWS::Partition}:ses:${AWS::Region}:${AWS::AccountId}:identity";
    expect(grant).toBe(
      [
        "              - Sid: SendEscalationEmail",
        "                Effect: Allow",
        "                Action: ses:SendEmail",
        "                Resource:",
        `                  - !Sub ${identity}/\${SesSender}`,
        `                  - !Sub ${identity}/\${SesStaffRecipient}`,
        "                Condition:",
        "                  StringEquals:",
        "                    ses:FromAddress: !Ref SesSender",
        "",
      ].join("\n"),
    );
  });
});

describe("sesNotifierFromEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is undefined when SES is not configured", () => {
    expect(sesNotifierFromEnv({ SCHED_ENV: "dev" })).toBeUndefined();
    expect(sesNotifierFromEnv({ SCHED_ENV: "dev", SES_SENDER: "", SES_STAFF_RECIPIENT: "" })).toBeUndefined();
  });

  it.each([
    ["only the sender", { SES_SENDER: SENDER }],
    ["only the recipient", { SES_STAFF_RECIPIENT: RECIPIENT }],
  ])("refuses %s", (_name, vars) => {
    expect(() => sesNotifierFromEnv({ SCHED_ENV: "dev", ...vars })).toThrow(
      "Set both SES_SENDER and SES_STAFF_RECIPIENT, or neither",
    );
  });

  it("needs SCHED_ENV for the metric", () => {
    expect(() => sesNotifierFromEnv({ SES_SENDER: SENDER, SES_STAFF_RECIPIENT: RECIPIENT })).toThrow(
      "SCHED_ENV is not set",
    );
  });

  it("builds its own SES client when none is given", async () => {
    const send = vi
      .spyOn(SESv2Client.prototype, "send")
      .mockImplementation((() =>
        Promise.resolve({ MessageId: "m-default" })) as unknown as SESv2Client["send"]);
    const vars = { SCHED_ENV: "dev", SES_SENDER: SENDER, SES_STAFF_RECIPIENT: RECIPIENT };
    await expect(sesNotifierFromEnv(vars)?.notifyEscalation(NOTICE)).resolves.toEqual({
      messageId: "m-default",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stamps the failure metric with the clock it is given", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const at = new Date("2026-10-05T16:00:00Z");
    const bad = fakeClient(() => Promise.reject(new Error("throttled")));
    const vars = { SCHED_ENV: "dev", SES_SENDER: SENDER, SES_STAFF_RECIPIENT: RECIPIENT };
    await expect(
      sesNotifierFromEnv(vars, bad.client, new FrozenClock(at))?.notifyEscalation(NOTICE),
    ).rejects.toThrow(NotificationSendError);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ _aws: { Timestamp: at.getTime() } });
  });

  it("sends with the configured addresses and reports failures for SCHED_ENV", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ok = fakeClient(() => Promise.resolve({ MessageId: "m-1" }));
    const vars = { SCHED_ENV: "pr52", SES_SENDER: SENDER, SES_STAFF_RECIPIENT: RECIPIENT };

    await expect(sesNotifierFromEnv(vars, ok.client)?.notifyEscalation(NOTICE)).resolves.toEqual({
      messageId: "m-1",
    });
    expect(sentInput(ok.send)).toMatchObject({
      FromEmailAddress: SENDER,
      Destination: { ToAddresses: [RECIPIENT] },
    });
    expect(write).not.toHaveBeenCalled();

    const bad = fakeClient(() => Promise.reject(new Error("throttled")));
    await expect(sesNotifierFromEnv(vars, bad.client)?.notifyEscalation(NOTICE)).rejects.toThrow(
      NotificationSendError,
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      Env: "pr52",
      NotificationFailed: 1,
    });
  });
});
