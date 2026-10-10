/**
 * The Lambda entry point's wiring (`handlers/chat.ts`): config from the environment, the AWS stores, the
 * Converse client, the system prompt, the SES notifier, the failed-notification metric and the console
 * logger. The AWS stores, the Converse client and the SES client are replaced with in-memory and scripted
 * stand-ins; everything else is the real module.
 */
import { PassThrough } from "node:stream";

import type * as Agent from "@sched/agent";
import type * as Ses from "@aws-sdk/client-sesv2";
import { parseChatResponseBody } from "@sched/contracts";
import { createInMemoryRepositories, type InMemoryRepositories } from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryTurnStore, type InMemoryTurnStore, type RestApiProxyEvent } from "../src";

const aws = vi.hoisted(() => ({
  calls: [] as unknown[],
  repos: undefined as InMemoryRepositories | undefined,
  turns: undefined as InMemoryTurnStore | undefined,
  /** Changes the in-memory repos before the handler wraps them. */
  tweak: undefined as ((repos: InMemoryRepositories) => void) | undefined,
}));
const llm = vi.hoisted(() => ({ steps: [] as unknown[], requests: [] as { system: unknown[] }[] }));
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
      constructor() {
        super(llm.steps as Agent.ScriptedStep[]);
        llm.requests = this.requests as unknown as { system: unknown[] }[];
      }
    },
  };
});

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

class MessageRejected extends Error {
  override readonly name = "MessageRejected";
}

beforeEach(async () => {
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
  vi.spyOn(console, "info").mockImplementation(() => undefined);
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
  await handler(event, stream, {});
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

/** Runs one escalating turn and returns the stored escalation and every EMF record written to stdout. */
async function escalate(times = 1) {
  await escalatingModel(times);
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const { handler } = await import("../src/handlers/chat");
  const events = await invoke(handler);
  const emf = write.mock.calls
    .map(([chunk]) => String(chunk))
    .filter((line) => line.includes('"_aws"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  write.mockRestore();
  const [escalation] = aws.repos?.snapshot().escalations ?? [];
  return { events, escalation, emf };
}

describe("handlers/chat", () => {
  it("builds the stores from TABLE_NAME and logs each turn through the console", async () => {
    const { handler } = await import("../src/handlers/chat");

    const events = await invoke(handler);
    expect(events.at(-1)?.type).toBe("done");
    expect(aws.calls).toEqual([expect.objectContaining({ tableName: "sched-test-table" })]);
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({ msg: "chat turn", terminal: "done" }),
    );
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

  it("sends the current system prompt (system.v1) with the patient's first name, and records its version", async () => {
    const { handler } = await import("../src/handlers/chat");

    await invoke(handler);
    const system = JSON.stringify(llm.requests[0]?.system);
    expect(system).toContain("The patient's first name, from their profile: Maria.");
    expect(aws.turns?.traces[0]?.trace.promptVersion).toBe("system.v1");
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

    it("writes no record when updateNotification finds no escalation to update", async () => {
      aws.tweak = (repos) => {
        repos.escalations.updateNotification = () => Promise.resolve(null);
      };

      const { escalation, emf } = await escalate();
      expect(escalation?.notification.status).toBe("PENDING");
      expect(emf).toEqual([]);
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
  });
});
