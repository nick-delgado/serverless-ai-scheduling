/**
 * The Lambda entry point's wiring (`handlers/chat.ts`): config from the environment, the AWS stores, the
 * Converse client, the system prompt, the SES notifier, the failed-notification metric, and the Powertools
 * logger, metrics and tracer (#38). The AWS stores, the Converse client, the SES client and the tracer are
 * replaced with in-memory, scripted and recording stand-ins; everything else is the real module.
 */
import { PassThrough } from "node:stream";

import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type * as Agent from "@sched/agent";
import type * as Ses from "@aws-sdk/client-sesv2";
import { parseChatResponseBody } from "@sched/contracts";
import { createInMemoryRepositories, type EscalationRepo, type InMemoryRepositories } from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENV_CAP_MESSAGE,
  createInMemoryTurnStore,
  type InMemoryTurnStore,
  type RestApiProxyEvent,
} from "../src";

const aws = vi.hoisted(() => ({
  calls: [] as unknown[],
  repos: undefined as InMemoryRepositories | undefined,
  turns: undefined as InMemoryTurnStore | undefined,
  /** Changes the in-memory repos before the handler wraps them. */
  tweak: undefined as ((repos: InMemoryRepositories) => void) | undefined,
}));
const llm = vi.hoisted(() => ({
  steps: [] as unknown[],
  requests: [] as { system: unknown[] }[],
  options: undefined as unknown,
}));
const tracing = vi.hoisted(() => ({ options: [] as unknown[], captured: [] as unknown[] }));
const ses = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("../src/lib/aws", () => ({
  createAwsStores: (options: { tableName: string; clock: never }) => {
    aws.calls.push(options);
    aws.repos = createInMemoryRepositories({ clock: options.clock, seed: buildClinicFixture() });
    aws.tweak?.(aws.repos);
    aws.turns = createInMemoryTurnStore();
    return { repos: aws.repos, turns: aws.turns };
  },
}));

vi.mock("@sched/agent", async (importOriginal) => {
  const agent = await importOriginal<typeof Agent>();
  return {
    ...agent,
    ConverseLlmClient: class extends agent.ScriptedLlmClient {
      constructor(options: unknown) {
        super(llm.steps as Agent.ScriptedStep[]);
        llm.options = options;
        llm.requests = this.requests as unknown as { system: unknown[] }[];
      }
    },
  };
});

vi.mock("@aws-lambda-powertools/tracer", () => ({
  Tracer: class {
    constructor(options: unknown) {
      tracing.options.push(options);
    }
    captureAWSv3Client<T>(client: T): T {
      tracing.captured.push(client);
      return client;
    }
  },
}));

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => ({
  ...(await importOriginal<typeof Ses>()),
  SESv2Client: class {
    send = ses.send;
  },
}));

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const event: RestApiProxyEvent = {
  body: JSON.stringify({ clientMessageId: "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c", text: "Hello" }),
  requestContext: { requestId: "req-1", authorizer: { claims: { sub: MARIA } } },
};

/** A synthetic Lambda context (no real account). */
const lambdaContext = { functionName: "sched-test-api-chat", awsRequestId: "lambda-req-1" };

class MessageRejected extends Error {
  override readonly name = "MessageRejected";
}

/** Every line the Powertools logger and metrics write (stdout and stderr), parsed. */
let written: Record<string, unknown>[];

beforeEach(async () => {
  written = [];
  const capture = (chunk: unknown) => written.push(JSON.parse(String(chunk)) as Record<string, unknown>) > 0;
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
  tracing.options.length = 0;
  tracing.captured.length = 0;
  aws.calls.length = 0;
  aws.tweak = undefined;
  ses.send.mockReset();
  const agent = await vi.importActual<typeof Agent>("@sched/agent");
  llm.steps = [agent.scriptedText("Hi!"), agent.scriptedText("Hi again!")];
  vi.resetModules();
  vi.stubGlobal("awslambda", {
    streamifyResponse: <T>(handler: T) => handler,
    HttpResponseStream: { from: (stream: awslambda.ResponseStream) => stream },
  });
  vi.stubEnv("TABLE_NAME", "sched-test-table");
  vi.stubEnv("SCHED_ENV", "test-env");
  vi.stubEnv("SES_SENDER", "");
  vi.stubEnv("SES_STAFF_RECIPIENT", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function invoke(handler: awslambda.StreamifyHandler<RestApiProxyEvent>) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  await handler(event, stream, lambdaContext);
  return parseChatResponseBody(Buffer.concat(chunks).toString("utf8"));
}

/** Configures SES (both addresses, synthetic). */
function withSes(): void {
  vi.stubEnv("SES_SENDER", "scheduling@example.com");
  vi.stubEnv("SES_STAFF_RECIPIENT", "front-desk@example.com");
}

/** `patients.get` answers the turn's own profile read, then gives `result` to the escalation's. */
function profileReadInEscalation(result: () => Promise<unknown>): void {
  aws.tweak = (repos) => {
    const get = repos.patients.get.bind(repos.patients);
    let calls = 0;
    repos.patients.get = (id) => (++calls === 1 ? get(id) : (result() as never));
  };
}

/** The model escalates `times` times (one tool call per step), then replies. */
async function escalatingModel(times: number): Promise<void> {
  const agent = await vi.importActual<typeof Agent>("@sched/agent");
  const call = (i: number) =>
    agent.scriptedToolUse([
      {
        id: `tu_${String(i)}`,
        name: "escalate_to_human",
        input: { reason: "patient_requested", summary: "The patient asked to speak with the front desk." },
      },
    ]);
  llm.steps = [
    ...Array.from({ length: times }, (_, i) => call(i)),
    agent.scriptedText("The front desk has your request."),
  ];
}

/** The written lines whose `message` is `message`. */
const logLines = (message: string) => written.filter((l) => l.message === message);

/** Runs one escalating turn and returns the stored escalation and every NotificationFailed record. */
async function escalate(times = 1) {
  await escalatingModel(times);
  const { handler } = await import("../src/handlers/chat");
  const events = await invoke(handler);
  const emf = written.filter((line) => "_aws" in line && "NotificationFailed" in line);
  const [escalation] = aws.repos?.snapshot().escalations ?? [];
  return { events, escalation, emf };
}

describe("handlers/chat", () => {
  it("builds the stores from TABLE_NAME and logs each turn through Powertools with the Lambda request ID", async () => {
    const { handler } = await import("../src/handlers/chat");

    const events = await invoke(handler);
    expect(events.at(-1)?.type).toBe("done");
    expect(aws.calls).toEqual([expect.objectContaining({ tableName: "sched-test-table" })]);
    expect(logLines("chat turn")).toEqual([
      expect.objectContaining({
        level: "INFO",
        service: "chat",
        terminal: "done",
        requestId: "req-1",
        function_request_id: "lambda-req-1",
      }),
    ]);
  });

  it("writes the turn's metrics, with the conflict retries counted in the turn, once per invocation", async () => {
    const { handler } = await import("../src/handlers/chat");
    const options = aws.calls[0] as { onConflictRetry: () => void };
    options.onConflictRetry();

    await invoke(handler);
    const records = written.filter((l) => "_aws" in l);
    expect(records).toEqual([
      expect.objectContaining({ Env: "test-env", Turns: 1, TurnErrors: 0, BookingConflictRetries: 1 }),
    ]);
    // The record follows the turn's log line: it is flushed once the turn is over.
    expect(written.indexOf(records[0] ?? {})).toBeGreaterThan(
      written.indexOf(logLines("chat turn")[0] ?? {}),
    );
  });

  it("traces the Bedrock, DynamoDB and SES clients with X-Ray, and no HTTPS calls", async () => {
    await import("../src/handlers/chat");

    expect(tracing.options).toEqual([{ serviceName: "chat", captureHTTPsRequests: false }]);
    const [ses, dynamo, bedrock] = tracing.captured;
    expect(ses).toBeInstanceOf((await import("@aws-sdk/client-sesv2")).SESv2Client);
    expect(dynamo).toBeInstanceOf(DynamoDBClient);
    expect(bedrock).toBeInstanceOf(BedrockRuntimeClient);
    expect(tracing.captured).toHaveLength(3);
    expect(aws.calls[0]).toMatchObject({ client: dynamo });
    expect(llm.options).toEqual({ client: bedrock });
  });

  it("applies DAILY_TURN_CAP from the environment", async () => {
    vi.stubEnv("DAILY_TURN_CAP", "1");
    const { handler } = await import("../src/handlers/chat");

    expect((await invoke(handler)).at(-1)?.type).toBe("done");
    expect((await invoke(handler)).at(-1)).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
      retryable: false,
    });
  });

  it("applies ENV_DAILY_TURN_CAP from the environment, with the env message", async () => {
    vi.stubEnv("ENV_DAILY_TURN_CAP", "1");
    const { handler } = await import("../src/handlers/chat");

    expect((await invoke(handler)).at(-1)?.type).toBe("done");
    expect((await invoke(handler)).at(-1)).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
      message: ENV_CAP_MESSAGE,
      retryable: false,
    });
  });

  it("sends the current system prompt with the patient's first name, and records its version", async () => {
    const { handler } = await import("../src/handlers/chat");
    const { buildSystemPrompt } = await vi.importActual<typeof Agent>("@sched/agent");

    await invoke(handler);
    const system = JSON.stringify(llm.requests[0]?.system);
    expect(system).toContain("The patient's first name, from their profile: Maria.");
    expect(aws.turns?.traces[0]?.trace.promptVersion).toBe(
      buildSystemPrompt({ now: new Date("2026-10-05T13:00:00Z") }).version,
    );
  });

  it("fails the cold start without SCHED_ENV", async () => {
    vi.stubEnv("SCHED_ENV", "");
    await expect(import("../src/handlers/chat")).rejects.toThrow("SCHED_ENV");
  });

  it("fails the cold start when only one SES address is set", async () => {
    vi.stubEnv("SES_SENDER", "scheduling@example.com");
    await expect(import("../src/handlers/chat")).rejects.toThrow("SES_SENDER and SES_STAFF_RECIPIENT");
  });

  describe("staff notifications and the failed-notification metric (one record per FAILED)", () => {
    it("emails staff through SES when it is configured, and writes no failure record", async () => {
      withSes();
      ses.send.mockResolvedValue({ MessageId: "ses-message-1" });

      const { events, escalation, emf } = await escalate();
      expect(events.at(-1)?.type).toBe("done");
      expect(ses.send).toHaveBeenCalledTimes(1);
      expect(escalation?.notification).toEqual({ status: "SENT", messageId: "ses-message-1" });
      expect(emf).toEqual([]);
    });

    it("writes one record, from the notifier alone, when the SES send fails", async () => {
      withSes();
      ses.send.mockRejectedValue(new MessageRejected("Email address is not verified."));

      const { escalation, emf } = await escalate();
      expect(escalation?.notification.status).toBe("FAILED");
      expect(emf).toEqual([expect.objectContaining({ errorName: "MessageRejected" })]);
    });

    it("writes one record (NotifierNotConfigured) when no notifier is configured", async () => {
      const { escalation, emf } = await escalate();
      expect(escalation?.notification).toEqual({ status: "FAILED", error: "No notifier configured" });
      expect(emf).toEqual([
        expect.objectContaining({
          Env: "test-env",
          NotificationFailed: 1,
          escalationId: escalation?.escalationId,
          conversationId: escalation?.conversationId,
          errorName: "NotifierNotConfigured",
        }),
      ]);
      expect(emf[0]?._aws).toMatchObject({
        CloudWatchMetrics: [{ Namespace: "Sched", Dimensions: [["Env"]] }],
      });
    });

    it("writes no second record when the model escalates again (already_escalated: true)", async () => {
      const { emf } = await escalate(2);
      expect(emf).toHaveLength(1);
    });

    it("writes no record, and logs the failed status write, when updateNotification finds no escalation", async () => {
      aws.tweak = (repos) => {
        repos.escalations.updateNotification = () => Promise.resolve(null);
      };

      const { escalation, emf } = await escalate();
      expect(escalation?.notification.status).toBe("PENDING");
      expect(emf).toEqual([]);
      expect(logLines("notification status write failed")).toEqual([
        expect.objectContaining({
          level: "ERROR",
          conversationId: escalation?.conversationId,
          notificationStatus: "FAILED",
          function_request_id: "lambda-req-1",
        }),
      ]);
      expect(logLines("notification status write failed")[0]).not.toHaveProperty("errorName");
      expect(logLines("notification status write failed")[0]).not.toHaveProperty("patientId");
    });

    it("writes no record, and logs the error, when updateNotification throws, leaving the escalation PENDING", async () => {
      aws.tweak = (repos) => {
        repos.escalations.updateNotification = () => Promise.reject(new RangeError("write failed"));
      };

      const { events, escalation, emf } = await escalate();
      expect(events.at(-1)?.type).toBe("done");
      expect(escalation?.notification.status).toBe("PENDING");
      expect(emf).toEqual([]);
      expect(logLines("notification status write failed")).toEqual([
        expect.objectContaining({
          level: "ERROR",
          conversationId: escalation?.conversationId,
          notificationStatus: "FAILED",
          errorName: "RangeError",
        }),
      ]);
      // Not an AWS SDK error, so its message isn't logged (lib/log.ts, #39 r1/Q-5 (b)).
      expect(logLines("notification status write failed")[0]).not.toHaveProperty("errorMessage");
      expect(logLines("notification status write failed")[0]).not.toHaveProperty("patientId");
      // The tool still swallowed the rethrown error: no tool internal error was logged.
      expect(logLines("tool internal error")).toEqual([]);
    });

    it("logs no failed status write when the status is stored", async () => {
      const { escalation } = await escalate();
      expect(escalation?.notification.status).toBe("FAILED");
      expect(logLines("notification status write failed")).toEqual([]);
    });

    it("works with an escalation repo whose methods live on a class prototype", async () => {
      /** Delegates through a private field, so its methods need `this` and aren't own properties. */
      class ClassEscalations implements EscalationRepo {
        readonly #inner: EscalationRepo;
        constructor(inner: EscalationRepo) {
          this.#inner = inner;
        }
        record(...args: Parameters<EscalationRepo["record"]>) {
          return this.#inner.record(...args);
        }
        getForConversation(...args: Parameters<EscalationRepo["getForConversation"]>) {
          return this.#inner.getForConversation(...args);
        }
        updateNotification(...args: Parameters<EscalationRepo["updateNotification"]>) {
          return this.#inner.updateNotification(...args);
        }
      }
      aws.tweak = (repos) => {
        repos.escalations = new ClassEscalations(repos.escalations);
      };

      const { escalation, emf } = await escalate();
      expect(escalation?.notification).toEqual({ status: "FAILED", error: "No notifier configured" });
      expect(emf).toEqual([expect.objectContaining({ errorName: "NotifierNotConfigured" })]);
    });

    it("writes one record when the patient's profile can't be read, without sending", async () => {
      withSes();
      profileReadInEscalation(() => Promise.reject(new RangeError("profile read failed")));

      const { escalation, emf } = await escalate();
      expect(ses.send).not.toHaveBeenCalled();
      expect(escalation?.notification.status).toBe("FAILED");
      expect(emf).toEqual([expect.objectContaining({ errorName: "RangeError" })]);
    });

    it("writes one record when the transcript can't be read, without sending", async () => {
      withSes();
      aws.tweak = (repos) => {
        repos.conversations.listMessages = () => Promise.reject(new SyntaxError("transcript read failed"));
      };

      const { emf } = await escalate();
      expect(ses.send).not.toHaveBeenCalled();
      expect(emf).toEqual([expect.objectContaining({ errorName: "SyntaxError" })]);
    });

    it("writes one record when the notice can't be built, without sending", async () => {
      withSes();
      profileReadInEscalation(() =>
        Promise.resolve(
          Object.defineProperty({}, "firstName", {
            get: () => {
              throw new TypeError("bad profile record");
            },
          }),
        ),
      );

      const { emf } = await escalate();
      expect(ses.send).not.toHaveBeenCalled();
      expect(emf).toEqual([expect.objectContaining({ errorName: "TypeError" })]);
    });

    it("names an error with no name UnknownError", async () => {
      withSes();

      profileReadInEscalation(() => Promise.reject("not an Error"));

      const { emf } = await escalate();
      expect(emf).toEqual([expect.objectContaining({ errorName: "UnknownError" })]);
    });

    // The name comes from the stored `name: message` text (owner decision c0dcd27/SPEC-1 (a)).
    it("names a non-Error rejection shaped like `Word: …` by its first word", async () => {
      withSes();

      profileReadInEscalation(() => Promise.reject("Throttled: slow down"));

      const { emf } = await escalate();
      expect(emf).toEqual([expect.objectContaining({ errorName: "Throttled" })]);
    });

    it("names an Error whose name isn't an identifier UnknownError", async () => {
      withSes();
      const error = new Error("profile read failed");
      error.name = "Some Error";
      profileReadInEscalation(() => Promise.reject(error));

      const { emf } = await escalate();
      expect(emf).toEqual([expect.objectContaining({ errorName: "UnknownError" })]);
    });
  });
});
