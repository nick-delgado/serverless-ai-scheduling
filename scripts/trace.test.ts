/**
 * scripts/trace.ts: argument checks, the printed fields, and the query, with an injected client; the
 * end-to-end runs read traces saved by the chat handler's own turn store on DynamoDB Local
 * (`DYNAMODB_ENDPOINT`, default http://localhost:8000). Without a reachable endpoint those are skipped
 * locally but fail in CI, where a DynamoDB Local service runs. All data is synthetic.
 */
import type { SSMClient } from "@aws-sdk/client-ssm";
import { PutCommand, type QueryCommand } from "@aws-sdk/lib-dynamodb";
import { createDynamoTurnStore } from "@sched/api/dynamo-turn-store";
import type { TurnTrace } from "@sched/contracts";
import { createDocumentClient } from "@sched/tools/dynamo";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  dynamoLocalAvailable,
  ENDPOINT,
  localClient,
  tableFactory,
} from "../packages/tools/test/dynamo/local";
import type * as seedData from "./seed-data";
import { ssmClientFor } from "./seed-data";
import { type CliDeps, main, parseCliArgs, readTraces, turnLines, turnView } from "./trace";

// The default SSM client, so a test can see main use it without reaching AWS.
vi.mock("./seed-data", async (importOriginal) => ({
  ...(await importOriginal<typeof seedData>()),
  ssmClientFor: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const CONV = "c0000000-0000-4000-8000-000000000001";
const OTHER_CONV = "c0000000-0000-4000-8000-000000000002";
// The earlier turn's ID sorts after the later one's, so DynamoDB's key order isn't startedAt order.
const TURN_1 = "b0000000-0000-4000-8000-000000000001";
const TURN_2 = "a0000000-0000-4000-8000-000000000002";
const UNKNOWN_CONV = "c0000000-0000-4000-8000-0000000000ff";
const PATIENT = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";
const SECRET_INPUT = "SECRET_TOOL_INPUT";

const usage = (n: number) => ({
  inputTokens: n,
  outputTokens: n + 1,
  cacheReadTokens: n + 2,
  cacheWriteTokens: n + 3,
});

const trace = (turnId: string, startedAt: string, over: Partial<TurnTrace> = {}): TurnTrace => ({
  turnId,
  conversationId: CONV,
  modelProfile: "sonnet-4.6",
  modelId: "us.anthropic.claude-sonnet-4-6",
  promptVersion: "system.v3",
  startedAt,
  durationMs: 4200,
  iterations: 2,
  llmCalls: [
    {
      index: 0,
      attempt: 0,
      modelId: "us.anthropic.claude-sonnet-4-6",
      startedAt,
      durationMs: 1500,
      ttftMs: 800,
      stopReason: "tool_use",
      usage: usage(100),
    },
    {
      index: 1,
      attempt: 1,
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      startedAt,
      durationMs: 900,
      stopReason: "refusal",
      providerStopReason: "guardrail_intervened",
      usage: usage(200),
    },
  ],
  toolCalls: [
    {
      toolUseId: "tooluse_01",
      name: "check_availability",
      known: true,
      input: { note: SECRET_INPUT },
      ok: true,
      durationMs: 42,
    },
    {
      toolUseId: "tooluse_02",
      name: "book_appointment",
      known: true,
      input: { slot_id: "slot-1" },
      ok: false,
      errorCode: "SLOT_UNAVAILABLE",
      durationMs: 77,
    },
  ],
  usage: usage(300),
  outcome: "completed",
  ...over,
});

const T1 = trace(TURN_1, "2026-10-13T12:00:00.000Z");
const T2 = trace(TURN_2, "2026-10-13T12:05:00.000Z", { outcome: "error", iterations: 1 });

function capture(): CliDeps & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (l) => out.push(l), logError: (l) => err.push(l) };
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("takes <env> <conversationId>, with --table, --json and --inputs off by default", () => {
    expect(parseCliArgs(["dev", CONV])).toEqual({
      env: "dev",
      conversationId: CONV,
      table: undefined,
      json: false,
      inputs: false,
    });
    expect(parseCliArgs(["dev", CONV, "--table", "t1", "--json", "--inputs"])).toEqual({
      env: "dev",
      conversationId: CONV,
      table: "t1",
      json: true,
      inputs: true,
    });
  });

  it.each([
    [[], /^usage: trace\.ts/],
    [["dev"], /^usage: trace\.ts/],
    [["dev", CONV, "extra"], /unexpected arguments: extra/],
    [["../x", CONV], /invalid env: \.\.\/x/],
    [["dev", "CONV#x"], /invalid conversationId: CONV#x/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe("main before any AWS call", () => {
  it("rejects an env such as ../x without calling SSM or DynamoDB, and defaults AWS_PROFILE", async () => {
    const ssmClient = vi.fn();
    const dynamoClient = vi.fn();
    const io = capture();
    const vars: Record<string, string | undefined> = {};
    expect(await main(["../x", CONV], vars, { ...io, ssmClient, dynamoClient })).toBe(1);
    expect(io.err).toEqual(["invalid env: ../x"]);
    expect(io.out).toEqual([]);
    expect(ssmClient).not.toHaveBeenCalled();
    expect(dynamoClient).not.toHaveBeenCalled();
    expect(vars.AWS_PROFILE).toBe("sched-dev");
  });

  it("keeps an AWS_PROFILE that is already set", async () => {
    const vars: Record<string, string | undefined> = { AWS_PROFILE: "other" };
    await main(["../x", CONV], vars, capture());
    expect(vars.AWS_PROFILE).toBe("other");
  });

  it("reports to console.error by default", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["../x", CONV], {})).toBe(1);
    expect(error).toHaveBeenCalledWith("invalid env: ../x");
  });

  it("reports a thrown non-Error as its string", async () => {
    const io = capture();
    const dynamoClient = () => {
      throw "no client";
    };
    expect(await main(["dev", CONV, "--table", "t1"], {}, { ...io, dynamoClient })).toBe(1);
    expect(io.err).toEqual(["no client"]);
  });

  it("needs --table when DYNAMODB_ENDPOINT is set", async () => {
    const io = capture();
    expect(await main(["dev", CONV], { DYNAMODB_ENDPOINT: ENDPOINT }, io)).toBe(1);
    expect(io.err).toEqual(["DYNAMODB_ENDPOINT is set: pass --table <name> for the local table"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

describe("turnLines", () => {
  it("prints the turn's, each model call's and each tool call's IDs and figures, and no tool input", () => {
    expect(turnLines(T1, false)).toEqual([
      `turn ${TURN_1} 2026-10-13T12:00:00.000Z completed`,
      "  profile sonnet-4.6, prompt system.v3, 2 iterations, 4200 ms, in 300 out 301 cache read 302 cache write 303",
      "  model 0.0 us.anthropic.claude-sonnet-4-6 tool_use, ttft 800 ms, 1500 ms, in 100 out 101 cache read 102 cache write 103",
      "  model 1.1 us.anthropic.claude-haiku-4-5-20251001-v1:0 refusal (guardrail_intervened), ttft -, 900 ms, in 200 out 201 cache read 202 cache write 203",
      "  tool check_availability ok, 42 ms",
      "  tool book_appointment failed SLOT_UNAVAILABLE, 77 ms",
    ]);
  });

  it("prints a failed tool call with no error code as failed -", () => {
    const failed = {
      toolUseId: "t",
      name: "book_appointment",
      known: true,
      input: {},
      ok: false,
      durationMs: 77,
    };
    const t = trace(TURN_1, T1.startedAt, { toolCalls: [failed] });
    expect(turnLines(t, false)).toContain("  tool book_appointment failed -, 77 ms");
  });

  it("prints each tool input under its call only with --inputs", () => {
    const lines = turnLines(T1, true);
    expect(lines.slice(4)).toEqual([
      "  tool check_availability ok, 42 ms",
      `    input {"note":"${SECRET_INPUT}"}`,
      "  tool book_appointment failed SLOT_UNAVAILABLE, 77 ms",
      '    input {"slot_id":"slot-1"}',
    ]);
  });
});

describe("turnView (--json)", () => {
  it("carries the same fields, with tool inputs only when asked", () => {
    expect(turnView(T1, false)).toEqual({
      turnId: TURN_1,
      startedAt: T1.startedAt,
      outcome: "completed",
      modelProfile: "sonnet-4.6",
      promptVersion: "system.v3",
      iterations: 2,
      durationMs: 4200,
      usage: usage(300),
      llmCalls: [
        {
          index: 0,
          attempt: 0,
          modelId: "us.anthropic.claude-sonnet-4-6",
          stopReason: "tool_use",
          providerStopReason: undefined,
          ttftMs: 800,
          durationMs: 1500,
          usage: usage(100),
        },
        {
          index: 1,
          attempt: 1,
          modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          stopReason: "refusal",
          providerStopReason: "guardrail_intervened",
          ttftMs: undefined,
          durationMs: 900,
          usage: usage(200),
        },
      ],
      toolCalls: [
        { name: "check_availability", ok: true, errorCode: undefined, durationMs: 42 },
        { name: "book_appointment", ok: false, errorCode: "SLOT_UNAVAILABLE", durationMs: 77 },
      ],
    });
    expect(turnView(T1, true).toolCalls.map((t) => t.input)).toEqual([
      { note: SECRET_INPUT },
      { slot_id: "slot-1" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The query, with an injected client
// ---------------------------------------------------------------------------------------------

describe("readTraces with an injected client", () => {
  // No stored startedAt: a readable item sorts by its trace's own.
  const item = (t: TurnTrace) => ({ SK: `TRACE#${t.turnId}`, trace: JSON.stringify(t) });

  it("queries only TRACE# items under CONV#<id>, never patientId, and follows every page", async () => {
    const pages = [
      { LastEvaluatedKey: { PK: `CONV#${CONV}`, SK: "TRACE#0" } },
      { Items: [item(T2)], LastEvaluatedKey: { PK: `CONV#${CONV}`, SK: `TRACE#${TURN_2}` } },
      { Items: [item(T1)] },
    ];
    const inputs: QueryCommand["input"][] = [];
    const send = vi.fn((command: QueryCommand) => {
      inputs.push(command.input);
      return Promise.resolve(pages[inputs.length - 1]);
    });
    const entries = await readTraces({ send } as never, "t1", CONV, { pageSize: 1 });

    expect(entries.map((e) => e.turnId)).toEqual([TURN_1, TURN_2]);
    expect(entries[0]?.trace).toEqual(T1);
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toEqual({
      TableName: "t1",
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": `CONV#${CONV}`, ":prefix": "TRACE#" },
      ProjectionExpression: "SK, startedAt, #trace",
      ExpressionAttributeNames: { "#trace": "trace" },
      ExclusiveStartKey: undefined,
      Limit: 1,
    });
    expect(inputs.slice(1).map((i) => i.ExclusiveStartKey)).toEqual([
      pages[0]?.LastEvaluatedKey,
      pages[1]?.LastEvaluatedKey,
    ]);
  });

  it("keeps an unreadable item, by the turn ID in its key, at its stored startedAt", async () => {
    const pages = [
      {
        Items: [
          item(T2),
          { SK: "TRACE#bad-json", startedAt: "2026-10-13T12:01:00.000Z", trace: "{not json" },
          { SK: "TRACE#not-a-trace", startedAt: "2026-10-13T11:00:00.000Z", trace: '{"turnId":"x"}' },
          { SK: "TRACE#no-trace", startedAt: "2026-10-13T12:10:00.000Z" },
          { SK: "TRACE#no-time", trace: 7 },
          item(T1),
        ],
      },
    ];
    const send = vi.fn(() => Promise.resolve(pages[0]));
    const entries = await readTraces({ send } as never, "t1", CONV);
    expect(entries.map((e) => [e.turnId, e.trace !== undefined])).toEqual([
      ["no-time", false],
      ["not-a-trace", false],
      [TURN_1, true],
      ["bad-json", false],
      [TURN_2, true],
      ["no-trace", false],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end, on DynamoDB Local
// ---------------------------------------------------------------------------------------------

// The DynamoDB Local harness every `*.local.test.ts` opens with.
// jscpd:ignore-start
const available = await dynamoLocalAvailable();
const client = localClient();
const tables = tableFactory(client);

afterAll(async () => {
  if (available) await tables.dropAll();
  client.destroy();
});
// jscpd:ignore-end

/** A table with T2 then T1 saved by the turn store, a message in the same partition, and another conversation's trace. */
async function seededTable(): Promise<string> {
  const tableName = await tables.create();
  const doc = createDocumentClient(client);
  const store = createDynamoTurnStore({ tableName, doc });
  await store.saveTrace(PATIENT, T2);
  await store.saveTrace(PATIENT, T1);
  await store.saveTrace(PATIENT, {
    ...trace("a0000000-0000-4000-8000-000000000009", T1.startedAt),
    conversationId: OTHER_CONV,
  });
  await doc.send(
    new PutCommand({
      TableName: tableName,
      Item: { PK: `CONV#${CONV}`, SK: "MSG#000000", entityType: "MESSAGE", content: "SECRET_MESSAGE_TEXT" },
    }),
  );
  return tableName;
}

const local = { DYNAMODB_ENDPOINT: ENDPOINT };

describe.skipIf(!available)("trace.ts on DynamoDB Local", () => {
  it("prints a two-turn conversation in startedAt order, without patient ID, messages or tool inputs", async () => {
    const table = await seededTable();
    const io = capture();
    expect(await main(["dev", CONV, "--table", table], { ...local }, io)).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.filter((l) => l.startsWith("turn "))).toEqual([
      `turn ${TURN_1} 2026-10-13T12:00:00.000Z completed`,
      `turn ${TURN_2} 2026-10-13T12:05:00.000Z error`,
    ]);
    expect(io.out).toHaveLength(12);
    const all = io.out.join("\n");
    for (const hidden of [PATIENT, SECRET_INPUT, "SECRET_MESSAGE_TEXT", OTHER_CONV])
      expect(all).not.toContain(hidden);
  });

  it("prints one JSON object per turn with --json, and tool inputs only with --inputs", async () => {
    const table = await seededTable();
    const io = capture();
    expect(await main(["dev", CONV, "--table", table, "--json"], { ...local }, io)).toBe(0);
    expect(io.out.map((l) => JSON.parse(l) as unknown)).toEqual([
      JSON.parse(JSON.stringify(turnView(T1, false))),
      JSON.parse(JSON.stringify(turnView(T2, false))),
    ]);

    const withInputs = capture();
    await main(["dev", CONV, "--table", table, "--json", "--inputs"], { ...local }, withInputs);
    expect(withInputs.out.join("\n")).toContain(SECRET_INPUT);
  });

  it("reads the table name from SSM /sched/<env>/data/table-name unless --table is given", async () => {
    const table = await seededTable();
    const names: unknown[] = [];
    const ssm: Pick<SSMClient, "send"> = {
      send: vi.fn((command: { input: { Name?: string } }) => {
        names.push(command.input.Name);
        return Promise.resolve({ Parameter: { Value: table } });
      }) as never,
    };
    const io = capture();
    const regions: unknown[] = [];
    const dynamo = localClient();
    const destroy = vi.spyOn(dynamo, "destroy");
    const deps: CliDeps = {
      ...io,
      ssmClient: (region) => (regions.push(region), ssm),
      dynamoClient: (region, endpoint) => (regions.push(region, endpoint), dynamo),
    };
    // An empty DYNAMODB_ENDPOINT counts as unset.
    expect(await main(["dev", CONV], { AWS_REGION: "eu-west-1", DYNAMODB_ENDPOINT: "" }, deps)).toBe(0);
    expect(names).toEqual(["/sched/dev/data/table-name"]);
    expect(regions).toEqual(["eu-west-1", "eu-west-1", undefined]);
    expect(io.out.filter((l) => l.startsWith("turn "))).toHaveLength(2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("uses the default SSM client in us-east-1, and prints to console.log and console.error", async () => {
    const table = await seededTable();
    vi.mocked(ssmClientFor).mockReturnValue({
      send: () => Promise.resolve({ Parameter: { Value: table } }),
    } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["dev", CONV], {}, { dynamoClient: () => localClient() })).toBe(0);
    expect(ssmClientFor).toHaveBeenCalledWith("us-east-1");
    expect(log).toHaveBeenCalledWith(`turn ${TURN_1} 2026-10-13T12:00:00.000Z completed`);

    expect(await main(["dev", UNKNOWN_CONV], {}, { dynamoClient: () => localClient() })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^No traces for conversation /));
  });

  it("says so on stderr and exits 1 when the conversation has no traces", async () => {
    const table = await seededTable();
    const io = capture();
    const unknown = UNKNOWN_CONV;
    expect(await main(["dev", unknown, "--table", table], { ...local }, io)).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err).toEqual([`No traces for conversation ${unknown} in table ${table}`]);
  });

  it("prints the readable turns, names the unreadable one, and exits 1", async () => {
    const table = await seededTable();
    await createDocumentClient(client).send(
      new PutCommand({
        TableName: table,
        Item: { PK: `CONV#${CONV}`, SK: "TRACE#broken", startedAt: "2026-10-13T12:02:00.000Z", trace: "{}" },
      }),
    );
    const io = capture();
    expect(await main(["dev", CONV, "--table", table], { ...local }, io)).toBe(1);
    expect(io.out.filter((l) => l.startsWith("turn "))).toHaveLength(2);
    expect(io.err).toEqual(["turn broken: unreadable trace"]);
  });

  it("pages through DynamoDB one item at a time", async () => {
    const table = await seededTable();
    const entries = await readTraces(createDocumentClient(client), table, CONV, { pageSize: 1 });
    expect(entries.map((e) => e.turnId)).toEqual([TURN_1, TURN_2]);
  });
});
