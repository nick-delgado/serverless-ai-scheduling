/**
 * scripts/retry-escalations.ts against DynamoDB Local (`DYNAMODB_ENDPOINT`, default http://localhost:8000),
 * with a recording notifier: nothing is emailed. Without a reachable endpoint the table tests are skipped
 * locally but fail in CI, where a DynamoDB Local service runs. All data is synthetic.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { type ConversationMessage, type Escalation, type EscalationReason } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import {
  buildEscalationNotice,
  FrozenClock,
  RecordingNotifier,
  type EscalationNotice,
  type Notifier,
  type Repositories,
} from "@sched/tools";
import { createDocumentClient, createDynamoRepositories, writeSeed } from "@sched/tools/dynamo";
import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dynamoLocalAvailable,
  ENDPOINT,
  localClient,
  tableFactory,
} from "../packages/tools/test/dynamo/local";
import { NOTICE } from "../packages/tools/test/notify/fixtures";
import {
  type CliDeps,
  DEFAULT_MIN_PENDING_AGE_MINUTES,
  findUnsentEscalations,
  main,
  parseCliArgs,
  retryEscalation,
  retryEscalations,
  runCli,
  sesNotifierFor,
} from "./retry-escalations";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const WALTER = FIXTURE_PATIENT_IDS["pat-walter"];
const NO_PROFILE_PATIENT = "0b3c5d7e-1f2a-4b6c-8d9e-0a1b2c3d4e5f"; // valid v4 UUID, no profile stored
const NOW = new Date("2026-10-05T15:00:00Z");
const MIN = 60_000;

const cli = (argv: string[], vars: Record<string, string | undefined>, deps?: CliDeps) =>
  runCli(parseCliArgs(argv), vars, deps);

const conv = (n: number): string => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A visible exchange plus a tool round trip that must never reach staff. */
const messages = (conversationId: string, at: string): ConversationMessage[] => [
  {
    conversationId,
    seq: 0,
    role: "user",
    content: [{ type: "text", text: "I need to talk to someone about my bill." }],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
  {
    conversationId,
    seq: 1,
    role: "assistant",
    content: [
      { type: "text", text: "Let me check your profile." },
      { type: "tool_use", id: "toolu_1", name: "get_patient_profile", input: { note: "SECRET_TOOL_INPUT" } },
    ],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
  {
    conversationId,
    seq: 2,
    role: "user",
    content: [{ type: "tool_result", toolUseId: "toolu_1", content: '{"first_name":"SECRET_TOOL_RESULT"}' }],
    turnId: EXAMPLES.TurnId,
    createdAt: at,
  },
];

describe("parseCliArgs", () => {
  it("takes the env as the first argument, with defaults", () => {
    expect(parseCliArgs(["dev"])).toEqual({
      env: "dev",
      dryRun: false,
      minPendingAgeMinutes: DEFAULT_MIN_PENDING_AGE_MINUTES,
      table: undefined,
      envFile: fileURLToPath(new URL("../.env", import.meta.url)),
    });
    expect(DEFAULT_MIN_PENDING_AGE_MINUTES).toBe(10);
  });

  it("reads the flags", () => {
    expect(
      parseCliArgs(["pr52", "--dry-run", "--min-pending-age", "0", "--table", "t", "--env-file", "/x/.env"]),
    ).toEqual({ env: "pr52", dryRun: true, minPendingAgeMinutes: 0, table: "t", envFile: "/x/.env" });
  });

  it.each([
    [
      [],
      /^usage: retry-escalations\.ts <env> \[--dry-run\] \[--min-pending-age <minutes>\] \[--table <name>\] \[--env-file <path>\]$/,
    ],
    [["dev", "demo"], /unexpected arguments: demo/],
    [["Dev"], /invalid env: Dev/],
    [["dev", "--min-pending-age", "5m"], /whole minutes, got 5m/],
    [["dev", "--min-pending-age=-1"], /whole minutes, got -1/],
    [["dev", "--min-pending-age", "1.5"], /whole minutes, got 1\.5/],
  ] as [string[], RegExp][])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe("main without a table", () => {
  it.each([
    ["defaults AWS_PROFILE to sched-dev", {}, "sched-dev"],
    ["keeps an AWS_PROFILE that is set", { AWS_PROFILE: "other" }, "other"],
  ])("%s", async (_case, preset: Record<string, string>, profile) => {
    const vars: Record<string, string | undefined> = { ...preset };
    const errors: string[] = [];
    expect(await main([], vars, { logError: (l) => errors.push(l) })).toBe(1);
    expect(vars.AWS_PROFILE).toBe(profile);
    expect(errors).toEqual([expect.stringMatching(/^usage: /) as string]);
  });
});

describe("sesNotifierFor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends from the sender to the recipient", async () => {
    const send = vi.fn(() => Promise.resolve({ MessageId: "m-1" }));
    const client = { send: send as unknown as SESv2Client["send"] };
    const n = sesNotifierFor("us-east-1", "sender@example.com", "desk@example.com", client);
    await expect(n.notifyEscalation(NOTICE)).resolves.toEqual({ messageId: "m-1" });
    const command = (send.mock.calls[0] as unknown[])[0] as SendEmailCommand;
    expect(command.input).toMatchObject({
      FromEmailAddress: "sender@example.com",
      Destination: { ToAddresses: ["desk@example.com"] },
    });
  });

  it("builds its own SES client in the region", async () => {
    const regions: string[] = [];
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async function (this: SESv2Client) {
      regions.push(await this.config.region());
      return { MessageId: "m-2" };
    } as unknown as SESv2Client["send"]);
    const n = sesNotifierFor("eu-west-1", "sender@example.com", "desk@example.com");
    await expect(n.notifyEscalation(NOTICE)).resolves.toEqual({ messageId: "m-2" });
    expect(regions).toEqual(["eu-west-1"]);
  });

  it("writes no metric line for a failed send", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const client = { send: (() => Promise.reject(new Error("throttled"))) as unknown as SESv2Client["send"] };
    const n = sesNotifierFor("us-east-1", "sender@example.com", "desk@example.com", client);
    await expect(n.notifyEscalation(NOTICE)).rejects.toThrow("Error: throttled");
    expect(write).not.toHaveBeenCalled();
  });
});

const available = await dynamoLocalAvailable();

describe.skipIf(!available)("retry-escalations on DynamoDB Local", { timeout: 30_000 }, () => {
  const client = localClient();
  const doc = createDocumentClient(client);
  const tables = tableFactory(client);
  let tableName: string;
  let clock: FrozenClock;
  let repos: Repositories;

  afterAll(async () => {
    await tables.dropAll();
    client.destroy();
  });

  beforeEach(async () => {
    tableName = await tables.create();
    clock = new FrozenClock(NOW);
    repos = createDynamoRepositories({ tableName, client, clock });
    const fixture = buildClinicFixture({ baseDate: "2026-10-05", weeks: 2 });
    const patients = fixture.patients.filter((p) => p.patientId === MARIA || p.patientId === WALTER);
    await writeSeed({ tableName, client, seed: { patients, providers: [], slots: [], appointments: [] } });
  });

  /** Record an escalation `ageMs` before NOW with the given notification, and its conversation. */
  async function escalate(
    patientId: string,
    conversationId: string,
    ageMs: number,
    notification: Escalation["notification"],
    reason: EscalationReason = "patient_requested",
  ): Promise<Escalation> {
    const at = new Date(NOW.getTime() - ageMs).toISOString();
    clock.set(at);
    await repos.conversations.append(patientId, messages(conversationId, at));
    const recorded = await repos.escalations.record({
      patientId,
      conversationId,
      reason,
      summary: "Patient wants to discuss a billing question with a person.",
      notification,
    });
    clock.set(NOW);
    if (!recorded.ok) throw new Error("record failed");
    return recorded.escalation;
  }

  const statusOf = async (patientId: string, conversationId: string) =>
    (await repos.escalations.getForConversation(patientId, conversationId))?.notification;

  const find = (minPendingAgeMs = 10 * MIN) =>
    findUnsentEscalations(doc, tableName, { now: NOW, minPendingAgeMs });

  describe("finding", () => {
    it("finds FAILED escalations of any age and PENDING ones at least the minimum age, oldest first", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "SENT", messageId: "m-1" });
      const failedNew = await escalate(MARIA, conv(2), 1 * MIN, { status: "FAILED", error: "Error: x" });
      const pendingOld = await escalate(WALTER, conv(3), 30 * MIN, { status: "PENDING" });
      await escalate(WALTER, conv(4), 9 * MIN, { status: "PENDING" });
      const failedOld = await escalate(WALTER, conv(5), 120 * MIN, { status: "FAILED", error: "Error: y" });
      const pendingAtLimit = await escalate(MARIA, conv(6), 10 * MIN, { status: "PENDING" });

      const found = await find();

      expect(found.map((e) => e.conversationId)).toEqual([conv(5), conv(3), conv(6), conv(2)]);
      expect(found).toEqual([failedOld, pendingOld, pendingAtLimit, failedNew]);
    });

    it("takes every PENDING one with a minimum age of 0", async () => {
      await escalate(MARIA, conv(1), 0, { status: "PENDING" });
      expect((await find(0)).map((e) => e.conversationId)).toEqual([conv(1)]);
    });

    it("ignores items that are not escalations, even with an unsent notification", async () => {
      // The seeded profiles, the conversations' messages and meta items share the table.
      const sent = await escalate(MARIA, conv(1), 60 * MIN, { status: "SENT", messageId: "m-1" });
      // An item shaped like an unsent escalation, under another entity type and key.
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: `CONV#${conv(2)}`,
            SK: "OTHER",
            entityType: "OTHER",
            ...sent,
            conversationId: conv(2),
            notification: { status: "FAILED", error: "Error: x" },
          },
        }),
      );
      expect(await find()).toEqual([]);
    });

    it("reads every page of the Scan", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      await escalate(WALTER, conv(2), 50 * MIN, { status: "FAILED", error: "Error: y" });
      await escalate(MARIA, conv(3), 40 * MIN, { status: "PENDING" });
      const send = vi.spyOn(doc, "send");
      const found = await findUnsentEscalations(doc, tableName, {
        now: NOW,
        minPendingAgeMs: 10 * MIN,
        pageSize: 1,
      });
      expect(found.map((e) => e.conversationId)).toEqual([conv(1), conv(2), conv(3)]);
      // One item per page: the escalations, the profiles and the messages take many pages.
      expect(send.mock.calls.length).toBeGreaterThan(3);
      send.mockRestore();
    });
  });

  describe("re-sending one", () => {
    it("rebuilds the notice from the stored profile and transcript", async () => {
      const escalation = await escalate(
        MARIA,
        conv(1),
        60 * MIN,
        { status: "FAILED", error: "Error: x" },
        "frustration",
      );
      const notifier = new RecordingNotifier();

      await retryEscalation(escalation, { repos, notifier });

      const expected: EscalationNotice = {
        escalationId: escalation.escalationId,
        conversationId: conv(1),
        patient: { firstName: "Maria", lastName: "Santos", dateOfBirth: expect.any(String) as string },
        reason: "frustration",
        summary: escalation.summary,
        createdAt: escalation.createdAt,
        createdLocal: "Monday, October 5, 2026 at 10:00 AM ET",
        transcript: [
          {
            role: "patient",
            text: "I need to talk to someone about my bill.",
            createdAt: escalation.createdAt,
          },
          { role: "assistant", text: "Let me check your profile.", createdAt: escalation.createdAt },
        ],
      };
      expect(notifier.sent).toEqual([expected]);
      const profile = await repos.patients.get(MARIA);
      expect(notifier.sent[0]?.patient?.dateOfBirth).toBe(profile?.dateOfBirth);
      expect(notifier.sent).toEqual([
        buildEscalationNotice(escalation, profile, await repos.conversations.listMessages(MARIA, conv(1))),
      ]);
      expect(JSON.stringify(notifier.sent)).not.toContain("SECRET_");
    });

    it("sends with no profile on file when the patient has none", async () => {
      const escalation = await escalate(NO_PROFILE_PATIENT, conv(1), 60 * MIN, {
        status: "FAILED",
        error: "Error: x",
      });
      const notifier = new RecordingNotifier();
      await retryEscalation(escalation, { repos, notifier });
      expect(notifier.sent[0]?.patient).toBeNull();
      expect(notifier.sent[0]?.transcript).toHaveLength(2);
    });

    it("records SENT with the new MessageId after a successful re-send", async () => {
      const escalation = await escalate(WALTER, conv(1), 60 * MIN, { status: "PENDING" });

      const outcome = await retryEscalation(escalation, { repos, notifier: new RecordingNotifier() });

      expect(outcome).toEqual({
        escalationId: escalation.escalationId,
        conversationId: conv(1),
        was: "PENDING",
        status: "SENT",
        messageId: "recorded-1",
      });
      expect(await statusOf(WALTER, conv(1))).toEqual({ status: "SENT", messageId: "recorded-1" });
    });

    it("records FAILED with the new error after a failed re-send", async () => {
      const escalation = await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: old" });
      const notifier = new RecordingNotifier();
      notifier.failWith(Object.assign(new Error("Throttled ".repeat(80)), { name: "NotificationSendError" }));

      const outcome = await retryEscalation(escalation, { repos, notifier });

      const error = `NotificationSendError: ${"Throttled ".repeat(80)}`.slice(0, 500);
      expect(outcome).toEqual({
        escalationId: escalation.escalationId,
        conversationId: conv(1),
        was: "FAILED",
        status: "FAILED",
        error,
      });
      expect(await statusOf(MARIA, conv(1))).toEqual({ status: "FAILED", error });
    });

    it("records FAILED when the transcript cannot be read, without sending", async () => {
      const escalation = await escalate(MARIA, conv(1), 60 * MIN, { status: "PENDING" });
      const notifier = new RecordingNotifier();
      const broken: Repositories = {
        ...repos,
        conversations: {
          ...repos.conversations,
          listMessages: () => Promise.reject(new Error("read timeout")),
        },
      };

      const outcome = await retryEscalation(escalation, { repos: broken, notifier });

      expect(outcome).toMatchObject({ status: "FAILED", error: "Error: read timeout" });
      expect(notifier.sent).toEqual([]);
      expect(await statusOf(MARIA, conv(1))).toEqual({ status: "FAILED", error: "Error: read timeout" });
    });

    it.each([
      ["an empty rejection", "", "Unknown error"],
      ["a non-Error rejection", "socket closed", "socket closed"],
      ["an Error with no message", new Error(""), "Error: "],
    ])("records FAILED with a non-empty error after %s", async (_case, reason, error) => {
      const escalation = await escalate(MARIA, conv(1), 60 * MIN, { status: "PENDING" });
      const notifier: Notifier = { notifyEscalation: () => Promise.reject(reason) };

      const outcome = await retryEscalation(escalation, { repos, notifier });

      expect(outcome).toMatchObject({ status: "FAILED", error });
      expect(await statusOf(MARIA, conv(1))).toEqual({ status: "FAILED", error });
    });

    it.each([
      [
        "throws",
        () => Promise.reject(new Error("throughput exceeded")),
        "status not recorded (Error: throughput exceeded)",
      ],
      [
        "finds no record",
        () => Promise.resolve(null),
        "status not recorded (Error: the escalation record is gone)",
      ],
    ] as const)("says so when the status update %s after a send", async (_case, update, error) => {
      const escalation = await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const broken: Repositories = {
        ...repos,
        escalations: { ...repos.escalations, updateNotification: update },
      };
      const outcome = await retryEscalation(escalation, { repos: broken, notifier: new RecordingNotifier() });
      expect(outcome).toMatchObject({ status: "SENT", messageId: "recorded-1", error });
    });

    it("keeps the send error when the status update also fails", async () => {
      const escalation = await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const notifier = new RecordingNotifier();
      notifier.failWith(new Error("rejected"));
      const broken: Repositories = {
        ...repos,
        escalations: { ...repos.escalations, updateNotification: () => Promise.reject(new Error("down")) },
      };
      const outcome = await retryEscalation(escalation, { repos: broken, notifier });
      expect(outcome.error).toBe("Error: rejected; status not recorded (Error: down)");
    });
  });

  describe("re-sending all", () => {
    const lines: string[] = [];
    beforeEach(() => {
      lines.length = 0;
    });
    const run = (notifier: Notifier | undefined) =>
      retryEscalations({
        doc,
        repos,
        tableName,
        notifier,
        now: NOW,
        minPendingAgeMs: 10 * MIN,
        log: (l) => lines.push(l),
      });

    it("re-sends each one on its own: a failure does not stop the rest", async () => {
      const first = await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const second = await escalate(WALTER, conv(2), 30 * MIN, { status: "PENDING" });
      const sent: string[] = [];
      let calls = 0;
      const notifier: Notifier = {
        notifyEscalation: (notice) => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error("throttled"));
          sent.push(notice.escalationId);
          return Promise.resolve({ messageId: "ses-2" });
        },
      };

      const summary = await run(notifier);

      expect(summary).toMatchObject({ found: 2, sent: 1, failed: 1 });
      expect(sent).toEqual([second.escalationId]);
      expect(await statusOf(MARIA, conv(1))).toEqual({ status: "FAILED", error: "Error: throttled" });
      expect(await statusOf(WALTER, conv(2))).toEqual({ status: "SENT", messageId: "ses-2" });
      expect(lines).toEqual([
        "2 escalation(s) to re-send",
        `${first.escalationId} (conversation ${conv(1)}): FAILED -> FAILED, Error: throttled`,
        `${second.escalationId} (conversation ${conv(2)}): PENDING -> SENT, MessageId ses-2`,
      ]);
    });

    it("counts an empty rejection as failed", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const summary = await run({ notifyEscalation: () => Promise.reject("") });
      expect(summary).toMatchObject({ found: 1, sent: 0, failed: 1 });
    });

    it("counts a send whose status was not recorded as failed", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const broken: Repositories = {
        ...repos,
        escalations: { ...repos.escalations, updateNotification: () => Promise.resolve(null) },
      };
      const summary = await retryEscalations({
        doc,
        repos: broken,
        tableName,
        notifier: new RecordingNotifier(),
        now: NOW,
        minPendingAgeMs: 10 * MIN,
        log: () => undefined,
      });
      expect(summary).toMatchObject({ found: 1, sent: 0, failed: 1 });
    });

    it("lists without sending or writing in a dry run", async () => {
      const escalation = await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });

      const summary = await run(undefined);

      expect(summary).toEqual({ found: 1, sent: 0, failed: 0, outcomes: [] });
      expect(await statusOf(MARIA, conv(1))).toEqual({ status: "FAILED", error: "Error: x" });
      expect(lines).toEqual([
        "1 escalation(s) to re-send",
        `would re-send ${escalation.escalationId} (conversation ${conv(1)}, FAILED)`,
      ]);
    });
  });

  describe("runCli", () => {
    const LOCAL = { DYNAMODB_ENDPOINT: ENDPOINT, AWS_REGION: "us-east-1" };
    const SES = { SES_SENDER: "sender@example.com", SES_STAFF_RECIPIENT: "desk@example.com" };

    it("re-sends through the notifier built from the SES settings and the region", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const recording = new RecordingNotifier();
      const notifierFor = vi.fn(
        (_region: string, _sender: string, _recipient: string): Notifier => recording,
      );

      const summary = await cli(
        ["dev", "--table", tableName],
        { ...LOCAL, ...SES, AWS_REGION: "us-west-2" },
        {
          now: NOW,
          notifier: notifierFor,
          dynamoClient: () => localClient(),
          log: () => undefined,
        },
      );

      expect(notifierFor).toHaveBeenCalledWith("us-west-2", SES.SES_SENDER, SES.SES_STAFF_RECIPIENT);
      expect(summary).toMatchObject({ found: 1, sent: 1, failed: 0 });
      expect(recording.sent).toHaveLength(1);
    });

    it("uses the minimum PENDING age and the clock it is given", async () => {
      await escalate(MARIA, conv(1), 5 * MIN, { status: "PENDING" });
      const deps = { now: NOW, notifier: () => new RecordingNotifier(), log: () => undefined };
      const args = ["dev", "--table", tableName, "--dry-run"];
      expect((await cli(args, LOCAL, deps)).found).toBe(0);
      expect((await cli([...args, "--min-pending-age", "5"], LOCAL, deps)).found).toBe(1);
      expect((await cli(args, LOCAL, { ...deps, now: new Date(NOW.getTime() + 5 * MIN) })).found).toBe(1);
    });

    it("needs the SES settings unless it is a dry run", async () => {
      const deps = { now: NOW, log: () => undefined };
      for (const vars of [
        LOCAL,
        { ...LOCAL, SES_SENDER: SES.SES_SENDER },
        { ...LOCAL, SES_STAFF_RECIPIENT: "x" },
      ]) {
        await expect(cli(["dev", "--table", tableName], vars, deps)).rejects.toThrow(
          /Set SES_SENDER and SES_STAFF_RECIPIENT .* or pass --dry-run/,
        );
      }
      await expect(cli(["dev", "--table", tableName, "--dry-run"], LOCAL, deps)).resolves.toMatchObject({
        found: 0,
      });
    });

    it("needs --table with a local endpoint", async () => {
      await expect(cli(["dev", "--dry-run"], LOCAL, { log: () => undefined })).rejects.toThrow(
        "DYNAMODB_ENDPOINT is set: pass --table <name>",
      );
    });

    it("uses --table without asking SSM", async () => {
      const ssmClient = vi.fn();
      const summary = await cli(
        ["dev", "--table", tableName, "--dry-run"],
        {},
        {
          now: NOW,
          ssmClient,
          dynamoClient: () => localClient(),
          log: () => undefined,
        },
      );
      expect(ssmClient).not.toHaveBeenCalled();
      expect(summary.found).toBe(0);
    });

    it("reads the table name from the env's SSM parameter without a local endpoint", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const send = vi.fn(() => Promise.resolve({ Parameter: { Value: tableName } }));
      const ssmClient = vi.fn(() => ({ send }) as unknown as Pick<SSMClient, "send">);

      const summary = await cli(
        ["pr52", "--dry-run"],
        { AWS_REGION: "us-east-2" },
        {
          now: NOW,
          ssmClient,
          dynamoClient: () => localClient(),
          log: () => undefined,
        },
      );

      expect(ssmClient).toHaveBeenCalledWith("us-east-2");
      expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({
        input: { Name: "/sched/pr52/data/table-name" },
      });
      expect(summary.found).toBe(1);
    });

    it("builds no notifier in a dry run, even with the SES settings", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const notifierFor = vi.fn((): Notifier => new RecordingNotifier());
      const summary = await cli(
        ["dev", "--table", tableName, "--dry-run"],
        { ...LOCAL, ...SES },
        {
          now: NOW,
          notifier: notifierFor,
          log: () => undefined,
        },
      );
      expect(notifierFor).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ found: 1, sent: 0, failed: 0 });
    });

    it("defaults the region to us-east-1", async () => {
      const notifierFor = vi.fn(
        (_region: string, _s: string, _r: string): Notifier => new RecordingNotifier(),
      );
      await cli(
        ["dev", "--table", tableName],
        { DYNAMODB_ENDPOINT: ENDPOINT, ...SES },
        {
          now: NOW,
          notifier: notifierFor,
          dynamoClient: () => localClient(),
          log: () => undefined,
        },
      );
      expect(notifierFor).toHaveBeenCalledWith("us-east-1", SES.SES_SENDER, SES.SES_STAFF_RECIPIENT);
    });
  });

  describe("main", () => {
    const LOCAL = { DYNAMODB_ENDPOINT: ENDPOINT, AWS_REGION: "us-east-1" };
    const quiet = { now: NOW, log: () => undefined, logError: () => undefined };
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "retry-escalations-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const envFile = (text: string): string => {
      const file = join(dir, ".env");
      writeFileSync(file, text);
      return file;
    };

    it("returns 1 when a re-send fails and 0 when all are sent", async () => {
      await escalate(MARIA, conv(1), 60 * MIN, { status: "FAILED", error: "Error: x" });
      const file = envFile("SES_SENDER=sender@example.com\nSES_STAFF_RECIPIENT=desk@example.com\n");
      const argv = ["dev", "--table", tableName, "--env-file", file];
      const failing = new RecordingNotifier();
      failing.failWith(new Error("throttled"));
      expect(await main(argv, { ...LOCAL }, { ...quiet, notifier: () => failing })).toBe(1);
      expect(await main(argv, { ...LOCAL }, { ...quiet, notifier: () => new RecordingNotifier() })).toBe(0);
    });

    it("loads the SES settings from --env-file, keeping values already set", async () => {
      const file = envFile(
        "SES_SENDER='file-sender@example.com'\nSES_STAFF_RECIPIENT=\"file-desk@example.com\"\n",
      );
      const argv = ["dev", "--table", tableName, "--env-file", file];
      const notifierFor = vi.fn(
        (_region: string, _s: string, _r: string): Notifier => new RecordingNotifier(),
      );
      const deps = { ...quiet, notifier: notifierFor };

      const vars: Record<string, string | undefined> = { ...LOCAL };
      expect(await main(argv, vars, deps)).toBe(0);
      expect(notifierFor).toHaveBeenLastCalledWith(
        "us-east-1",
        "file-sender@example.com",
        "file-desk@example.com",
      );
      expect(vars.SES_SENDER).toBe("file-sender@example.com");

      expect(await main(argv, { ...LOCAL, SES_SENDER: "set@example.com" }, deps)).toBe(0);
      expect(notifierFor).toHaveBeenLastCalledWith("us-east-1", "set@example.com", "file-desk@example.com");
    });

    it("runs without an env file when the file is missing", async () => {
      const argv = ["dev", "--table", tableName, "--dry-run", "--env-file", join(dir, "missing.env")];
      expect(await main(argv, { ...LOCAL }, quiet)).toBe(0);
    });
  });
});
