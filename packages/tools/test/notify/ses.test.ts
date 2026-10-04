import { readFileSync } from "node:fs";

import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderEscalationEmail } from "../../src/notify/render";
import {
  emfFailureReporter,
  NOTIFICATION_FAILED_METRIC,
  NotificationSendError,
  notificationFailedEmf,
  redactAddresses,
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

  it("is written to stdout as one raw line", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    emfFailureReporter("pr52")(failure);
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("}\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      Env: "pr52",
      NotificationFailed: 1,
      errorName: "MessageRejected",
    });
  });

  it("matches the alarm in infra/stacks/api.yaml", () => {
    const template = readFileSync(new URL("../../../../infra/stacks/api.yaml", import.meta.url), "utf8");
    const alarm = /NotificationFailedAlarm:\n(?:(?: {4}.*)?\n)+/.exec(template)?.[0] ?? "";
    expect(alarm).toContain(`Namespace: ${NOTIFICATION_FAILED_METRIC.namespace}\n`);
    expect(alarm).toContain(`MetricName: ${NOTIFICATION_FAILED_METRIC.name}\n`);
    expect(alarm).toContain(`- Name: ${NOTIFICATION_FAILED_METRIC.dimension}\n`);
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
