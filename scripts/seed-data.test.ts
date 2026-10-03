/**
 * scripts/seed-data.ts against DynamoDB Local (`DYNAMODB_ENDPOINT`, default http://localhost:8000).
 * Without a reachable endpoint the table tests are skipped locally but fail in CI, where a DynamoDB Local
 * service runs. Mappings are temporary files with synthetic subs; nothing reads `.seed/`.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import type { SSMClient } from "@aws-sdk/client-ssm";
import {
  type BatchWriteCommandInput,
  DeleteCommand,
  type DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { clinicDateOf } from "@sched/tools";
import { createDocumentClient, createTableInput, keys } from "@sched/tools/dynamo";
import { FIXTURE_PATIENT_IDS, type FixturePatientAlias } from "@sched/tools/fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDataSeed,
  DELETE_MAX_ATTEMPTS,
  deleteRows,
  dynamoClientFor,
  loadMapping,
  parseCliArgs,
  resetConfirmed,
  runCli,
  seedData,
  ssmParamFrom,
} from "./seed-data";
import type { UserMapping } from "./seed-users";

const ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";

/** Synthetic Cognito subs (v4-shaped, not from any pool). */
const SUBS: Record<FixturePatientAlias, string> = {
  "pat-maria": "a1111111-1111-4111-8111-111111111111",
  "pat-walter": "b2222222-2222-4222-8222-222222222222",
  "pat-aisha": "c3333333-3333-4333-8333-333333333333",
  "pat-daniel": "d4444444-4444-4444-8444-444444444444",
  "pat-sofia": "e5555555-5555-4555-8555-555555555555",
  "pat-james": "f6666666-6666-4666-8666-666666666666",
};
const POOL = "us-east-1_TestPool1";

function mappingFor(aliases: readonly FixturePatientAlias[], env = "dev"): UserMapping {
  return {
    env,
    userPoolId: POOL,
    updatedAt: "2026-10-01T12:00:00.000Z",
    users: aliases.map((alias) => ({
      alias,
      fixturePatientId: FIXTURE_PATIENT_IDS[alias],
      username: alias.replace("pat-", "") + ".test",
      sub: SUBS[alias],
    })),
  };
}

// Wed Oct 7, 2026, 10:00 PM in New York (EDT) is already Oct 8 in UTC.
const LATE_EVENING = new Date("2026-10-08T02:00:00Z");
const NEXT_DAY = new Date("2026-10-08T14:00:00Z");

// ---------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------

describe("buildDataSeed", () => {
  it("starts the 4-week window on the clinic-local date, not the UTC date", () => {
    const { seed, baseDate } = buildDataSeed(mappingFor(["pat-maria"]), LATE_EVENING);
    expect(baseDate).toBe("2026-10-07");
    const days = [...new Set(seed.slots.map((s) => clinicDateOf(s.startUtc)))].sort();
    expect(days[0]).toBe("2026-10-07");
    // [Oct 7, Nov 4): the last weekday is Tue Nov 3, and Wed Nov 4 is outside.
    expect(days.at(-1)).toBe("2026-11-03");
    expect(days).toHaveLength(20);
  });

  it("rewrites every mapped patient ID to its sub and leaves no fixture patient ID anywhere", () => {
    const all = Object.keys(FIXTURE_PATIENT_IDS) as FixturePatientAlias[];
    const { seed, skipped } = buildDataSeed(mappingFor(all), LATE_EVENING);
    expect(skipped).toEqual([]);
    expect(seed.patients.map((p) => p.patientId).sort()).toEqual(Object.values(SUBS).sort());
    expect(new Set(seed.appointments.map((a) => a.patientId))).toEqual(
      new Set([SUBS["pat-maria"], SUBS["pat-walter"], SUBS["pat-daniel"], SUBS["pat-sofia"]]),
    );
    const text = JSON.stringify(seed);
    for (const id of Object.values(FIXTURE_PATIENT_IDS)) expect(text).not.toContain(id);
  });

  it("skips unmapped patients and their appointments, and reopens the slots those held", () => {
    const { seed, skipped } = buildDataSeed(mappingFor(["pat-maria"]), LATE_EVENING);
    expect(skipped).toEqual(["pat-walter", "pat-aisha", "pat-daniel", "pat-sofia", "pat-james"]);
    expect(seed.patients.map((p) => p.patientId)).toEqual([SUBS["pat-maria"]]);
    expect(seed.appointments.map((a) => a.patientId)).toEqual([SUBS["pat-maria"]]);
    const booked = seed.slots.filter((s) => s.status === "BOOKED");
    expect(booked.map((s) => s.appointmentId)).toEqual([seed.appointments[0]?.appointmentId]);
    expect(seed.slots.filter((s) => s.appointmentId !== undefined)).toHaveLength(1);
    const text = JSON.stringify(seed);
    for (const id of Object.values(FIXTURE_PATIENT_IDS)) expect(text).not.toContain(id);
  });
});

describe("loadMapping", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-data-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
    return path;
  };

  it("says to run seed-users when the file is missing", () => {
    expect(() => loadMapping(join(dir, "none.json"), { env: "dev" })).toThrow(
      /No user mapping at .*none\.json\. Run `npx tsx scripts\/seed-users\.ts --env dev` first/,
    );
  });

  it("rejects a file that is not JSON or not the mapping shape", () => {
    expect(() => loadMapping(write("bad.json", "{not json"), { env: "dev" })).toThrow(/not valid JSON/);
    expect(() => loadMapping(write("shape.json", { env: "dev", users: [] }), { env: "dev" })).toThrow(
      /expected shape/,
    );
  });

  it("rejects a mapping for another env or User Pool, an empty one, or a row with the wrong fixture ID", () => {
    expect(() => loadMapping(write("a.json", mappingFor(["pat-maria"], "demo")), { env: "dev" })).toThrow(
      /for env 'demo', not 'dev'/,
    );
    const ok = write("b.json", mappingFor(["pat-maria"]));
    expect(() => loadMapping(ok, { env: "dev", userPoolId: "us-east-1_Other" })).toThrow(/User Pool/);
    expect(loadMapping(ok, { env: "dev", userPoolId: POOL }).users).toHaveLength(1);
    expect(() => loadMapping(write("c.json", mappingFor([])), { env: "dev" })).toThrow(/lists no users/);
    const wrong = mappingFor(["pat-maria"]);
    wrong.users = wrong.users.map((u) => ({ ...u, fixturePatientId: FIXTURE_PATIENT_IDS["pat-walter"] }));
    expect(() => loadMapping(write("d.json", wrong), { env: "dev" })).toThrow(
      /pat-maria has fixturePatientId/,
    );
  });
});

describe("resetConfirmed", () => {
  it("needs --confirm to equal the table name, or a typed answer that does", async () => {
    expect(await resetConfirmed("t1", undefined, undefined)).toBe(false);
    expect(await resetConfirmed("t1", "t2", async () => "t1")).toBe(false);
    expect(await resetConfirmed("t1", "t1", undefined)).toBe(true);
    expect(await resetConfirmed("t1", undefined, async () => "yes")).toBe(false);
    expect(await resetConfirmed("t1", undefined, async () => " t1\n")).toBe(true);
  });
});

describe("parseCliArgs", () => {
  it("requires a valid --env and allows --confirm only with --reset", () => {
    expect(() => parseCliArgs([])).toThrow(/--env is required/);
    expect(() => parseCliArgs(["--env", "Dev!"])).toThrow(/invalid env/);
    expect(() => parseCliArgs(["--env", "dev", "--confirm", "t"])).toThrow(/only applies to --reset/);
    expect(parseCliArgs(["--env", "dev", "--reset", "--confirm", "t"])).toMatchObject({
      env: "dev",
      reset: true,
      confirm: "t",
    });
  });
});

/** A client whose `send` records each command's input and answers with `reply(input, call)`. */
function fakeClient<C>(reply: (input: Record<string, unknown>, call: number) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    send(command: { input: Record<string, unknown> }) {
      sent.push(command.input);
      return Promise.resolve(reply(command.input, sent.length));
    },
  };
  return { sent, client: client as unknown as C };
}

describe("deleteRows", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    PK: `PROVIDER#p${String(i)}`,
    SK: "PROFILE",
    other: i,
  }));
  const deletes = (input: Record<string, unknown>) =>
    ((input as BatchWriteCommandInput).RequestItems?.t1 ?? []).map((r) => r.DeleteRequest?.Key);

  it("deletes by key in batches of 25 and re-sends only the unprocessed deletes after a wait", async () => {
    const { sent, client } = fakeClient<Pick<DynamoDBDocumentClient, "send">>((input, call) =>
      call === 1
        ? {
            UnprocessedItems: {
              t1: [
                ...((input as BatchWriteCommandInput).RequestItems?.t1 ?? []).slice(3, 5),
                { PutRequest: { Item: { PK: "x", SK: "y" } } },
              ],
            },
          }
        : {},
    );
    const waits: number[] = [];
    await deleteRows(client, "t1", rows, async (ms) => void waits.push(ms));
    expect(sent.map(deletes)).toEqual([
      rows.slice(0, 25).map((r) => ({ PK: r.PK, SK: r.SK })),
      rows.slice(3, 5).map((r) => ({ PK: r.PK, SK: r.SK })),
      rows.slice(25).map((r) => ({ PK: r.PK, SK: r.SK })),
    ]);
    expect(waits).toEqual([100]);
  });

  it(`gives up on a batch after ${String(DELETE_MAX_ATTEMPTS)} calls that leave deletes unprocessed`, async () => {
    const { sent, client } = fakeClient<Pick<DynamoDBDocumentClient, "send">>((input) => ({
      UnprocessedItems: { t1: (input as BatchWriteCommandInput).RequestItems?.t1 },
    }));
    const waits: number[] = [];
    await expect(
      deleteRows(client, "t1", rows.slice(0, 2), async (ms) => void waits.push(ms)),
    ).rejects.toThrow("reset: 2 deletes still unprocessed");
    expect(DELETE_MAX_ATTEMPTS).toBe(8);
    expect(sent).toHaveLength(8);
    expect(waits).toEqual([100, 200, 400, 800, 1600, 3200, 6400, 12800]);
  });
});

describe("ssmParamFrom", () => {
  it("reads /sched/<env>/<name> and refuses a missing or empty value", async () => {
    const values: Record<string, unknown> = {
      "/sched/dev/data/table-name": { Parameter: { Value: "sched-dev-table" } },
      "/sched/dev/auth/user-pool-id": { Parameter: { Value: "" } },
      "/sched/dev/none": {},
    };
    const { sent, client } = fakeClient<Pick<SSMClient, "send">>((input) => values[String(input.Name)]);
    const param = ssmParamFrom(client);
    await expect(param("dev", "data/table-name")).resolves.toBe("sched-dev-table");
    expect(sent).toEqual([{ Name: "/sched/dev/data/table-name" }]);
    await expect(param("dev", "auth/user-pool-id")).rejects.toThrow(
      "SSM /sched/dev/auth/user-pool-id is empty",
    );
    await expect(param("dev", "none")).rejects.toThrow("SSM /sched/dev/none is empty");
  });
});

describe("dynamoClientFor", () => {
  it("points at the endpoint with dummy credentials when one is given, else at the region's AWS endpoint", async () => {
    const local = dynamoClientFor("eu-west-1", "http://localhost:8001");
    const aws = dynamoClientFor("eu-west-1", undefined);
    try {
      expect(await local.config.region()).toBe("eu-west-1");
      expect(await local.config.endpoint?.()).toMatchObject({ hostname: "localhost", port: 8001 });
      expect(await local.config.credentials()).toMatchObject({
        accessKeyId: "local",
        secretAccessKey: "local",
      });
      expect(await aws.config.region()).toBe("eu-west-1");
      expect(aws.config.endpoint).toBeUndefined();
    } finally {
      local.destroy();
      aws.destroy();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Against DynamoDB Local
// ---------------------------------------------------------------------------------------------

function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 3,
  });
}

async function dynamoLocalAvailable(): Promise<boolean> {
  const client = localClient();
  try {
    await client.send(new ListTablesCommand({ Limit: 1 }), { abortSignal: AbortSignal.timeout(2000) });
    return true;
  } catch (err) {
    if (process.env.CI) {
      throw new Error(`DynamoDB Local is required in CI but ${ENDPOINT} is unreachable`, { cause: err });
    }
    process.stderr.write(
      `\n[seed-data] SKIPPING the DynamoDB Local tests: no DynamoDB Local at ${ENDPOINT} (set DYNAMODB_ENDPOINT).\n`,
    );
    return false;
  } finally {
    client.destroy();
  }
}

const available = await dynamoLocalAvailable();

// Each seed writes ~2,900 items in batches of 25; give a loaded machine or CI runner room.
describe.skipIf(!available)("seedData on DynamoDB Local", { timeout: 60_000 }, () => {
  const client = localClient();
  const doc = createDocumentClient(client);
  const created: string[] = [];
  let table: string;

  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  beforeEach(async () => {
    table = `sched-seed-test-${randomUUID().slice(0, 8)}`;
    await client.send(new CreateTableCommand(createTableInput(table)));
    await waitUntilTableExists({ client, maxWaitTime: 30, minDelay: 0.1, maxDelay: 1 }, { TableName: table });
    created.push(table);
  });
  afterAll(async () => {
    await Promise.all(created.map((TableName) => client.send(new DeleteTableCommand({ TableName }))));
    client.destroy();
    vi.restoreAllMocks();
  });

  async function scan(): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const out = await doc.send(
        new ScanCommand({ TableName: table, ExclusiveStartKey: start, ConsistentRead: true }),
      );
      items.push(...(out.Items ?? []));
      start = out.LastEvaluatedKey;
    } while (start);
    return items;
  }
  const byType = (items: Record<string, unknown>[], t: string) => items.filter((i) => i.entityType === t);
  const sortKey = (i: Record<string, unknown>) => `${String(i.PK)}|${String(i.SK)}`;
  const sorted = (xs: Record<string, unknown>[]) =>
    [...xs].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const run = (mapping: UserMapping, now: Date, extra: Partial<Parameters<typeof seedData>[0]> = {}) =>
    seedData({ tableName: table, client, mapping, now, ...extra });

  /** Every BOOKED slot is held by a BOOKED appointment for that slot, and vice versa. */
  function expectConsistentBookings(items: Record<string, unknown>[]): void {
    const appts = new Map(byType(items, "APPOINTMENT").map((a) => [a.appointmentId, a]));
    const booked = byType(items, "SLOT").filter((s) => s.status === "BOOKED");
    for (const s of booked) {
      const a = appts.get(s.appointmentId);
      expect(a?.status, `slot ${String(s.slotId)}`).toBe("BOOKED");
      expect(a?.slotId, `slot ${String(s.slotId)}`).toBe(s.slotId);
    }
    const heldBy = new Set(booked.map((s) => s.appointmentId));
    for (const a of appts.values()) if (a.status === "BOOKED") expect(heldBy.has(a.appointmentId)).toBe(true);
  }

  it("writes providers, slots, mapped profiles keyed by sub, and their appointments", async () => {
    const result = await run(mappingFor(["pat-maria", "pat-walter"]), LATE_EVENING);
    const items = await scan();
    expect(result).toMatchObject({ baseDate: "2026-10-07", deleted: 0, written: items.length });
    expect(byType(items, "PROVIDER")).toHaveLength(8);
    expect(byType(items, "SLOT")).toHaveLength(8 * 20 * 18);
    expect(
      byType(items, "PATIENT")
        .map((p) => p.PK)
        .sort(),
    ).toEqual([`PATIENT#${SUBS["pat-maria"]}`, `PATIENT#${SUBS["pat-walter"]}`]);
    const appts = byType(items, "APPOINTMENT");
    expect(appts).toHaveLength(3); // Maria 1 BOOKED; Walter 1 BOOKED + 1 COMPLETED
    for (const a of appts) expect(a.PK).toBe(`PATIENT#${String(a.patientId)}`);
    expect(new Set(appts.map((a) => a.patientId))).toEqual(new Set([SUBS["pat-maria"], SUBS["pat-walter"]]));
    const text = JSON.stringify(items);
    for (const id of Object.values(FIXTURE_PATIENT_IDS)) expect(text).not.toContain(id);
    expectConsistentBookings(items);
  });

  it("is idempotent: a second run on the same day leaves the same items", async () => {
    const mapping = mappingFor(["pat-maria", "pat-daniel"]);
    await run(mapping, LATE_EVENING);
    const first = await scan();
    const again = await run(mapping, LATE_EVENING);
    const second = await scan();
    expect(second).toHaveLength(first.length);
    expect(sorted(second)).toEqual(sorted(first));
    // Only the profiles are rewritten; no slot or appointment is written again.
    expect(again.written).toBe(8 + 2);
  });

  it("on a later day extends the window, keeps profiles' createdAt, and never moves or duplicates appointments", async () => {
    const mapping = mappingFor(["pat-maria", "pat-walter", "pat-daniel", "pat-sofia"]);
    await run(mapping, LATE_EVENING);
    const before = await scan();
    await run(mapping, new Date("2026-10-13T14:00:00Z")); // the next Tuesday
    const after = await scan();

    const days = [...new Set(byType(after, "SLOT").map((s) => clinicDateOf(String(s.startUtc))))].sort();
    expect(days[0]).toBe("2026-10-07");
    expect(days.at(-1)).toBe("2026-11-09"); // [Oct 13, Nov 10)
    expect(byType(after, "APPOINTMENT")).toEqual(expect.arrayContaining(byType(before, "APPOINTMENT")));
    expect(byType(after, "APPOINTMENT")).toHaveLength(byType(before, "APPOINTMENT").length);
    expect(byType(after, "PATIENT")).toEqual(expect.arrayContaining(byType(before, "PATIENT")));
    expectConsistentBookings(after);
  });

  it("weeks later, writes the new slot of an already-stored appointment as OPEN, not booked by it", async () => {
    const mapping = mappingFor(["pat-maria"]);
    await run(mapping, LATE_EVENING);
    const [appt] = byType(await scan(), "APPOINTMENT");
    await run(mapping, new Date("2026-11-10T15:00:00Z")); // past the first window: day 6 is a new slot
    const items = await scan();
    expect(byType(items, "APPOINTMENT")).toEqual([appt]);
    const booked = byType(items, "SLOT").filter((s) => s.status === "BOOKED");
    expect(booked.map((s) => s.slotId)).toEqual([appt?.slotId]);
    expectConsistentBookings(items);
  });

  it("never overwrites a booking made after the seed", async () => {
    const mapping = mappingFor(["pat-maria"]);
    await run(mapping, LATE_EVENING);
    // A slot inside both runs' windows ([Oct 7, Nov 4) and [Oct 8, Nov 5)), so the second run writes it.
    const open = byType(await scan(), "SLOT").find(
      (s) => s.status === "OPEN" && clinicDateOf(String(s.startUtc)) >= "2026-10-08",
    );
    if (!open) throw new Error("no open slot");
    await doc.send(
      new UpdateCommand({
        TableName: table,
        Key: { PK: open.PK, SK: open.SK },
        UpdateExpression: "SET #s = :b, appointmentId = :a REMOVE GSI1PK, GSI1SK",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":b": "BOOKED", ":a": "appt_AGENTMADE0000000000000000" },
      }),
    );
    await run(mapping, NEXT_DAY);
    const slot = (await scan()).find((i) => i.PK === open.PK && i.SK === open.SK);
    expect(slot).toMatchObject({ status: "BOOKED", appointmentId: "appt_AGENTMADE0000000000000000" });
  });

  it("for patients mapped later, adds unbooked appointments but skips BOOKED ones whose slot exists", async () => {
    await run(mappingFor(["pat-maria"]), LATE_EVENING);
    await run(mappingFor(["pat-maria", "pat-walter", "pat-daniel"]), LATE_EVENING);
    const items = await scan();
    const statuses = (alias: FixturePatientAlias) =>
      byType(items, "APPOINTMENT")
        .filter((a) => a.patientId === SUBS[alias])
        .map((a) => a.status)
        .sort();
    expect(statuses("pat-walter")).toEqual(["COMPLETED"]);
    expect(statuses("pat-daniel")).toEqual(["CANCELLED"]);
    expect(byType(items, "SLOT").filter((s) => s.status === "BOOKED")).toHaveLength(1); // Maria's
    expectConsistentBookings(items);
  });

  it("--reset refuses without confirmation and leaves the table untouched", async () => {
    const mapping = mappingFor(["pat-maria"]);
    await run(mapping, LATE_EVENING);
    const before = await scan();
    const confirm = vi.fn(async () => false);
    await expect(run(mapping, NEXT_DAY, { reset: true, confirmReset: confirm })).rejects.toThrow(
      /not confirmed; nothing was changed/,
    );
    await expect(run(mapping, NEXT_DAY, { reset: true })).rejects.toThrow(/not confirmed/);
    expect(confirm).toHaveBeenCalledOnce();
    expect(sorted(await scan())).toEqual(sorted(before));
  });

  it("--reset deletes seed-owned items (old slots, agent bookings) but keeps conversations", async () => {
    const mapping = mappingFor(["pat-maria"]);
    await run(mapping, LATE_EVENING);
    const sub = SUBS["pat-maria"];
    const agentAppt = {
      ...keys.appointment(sub, "appt_AGENTMADE0000000000000000"),
      entityType: "APPOINTMENT",
    };
    const conv = {
      ...keys.conversationMeta(sub, "2026-10-07T15:00:00.000Z", "conv-1"),
      entityType: "CONVERSATION",
    };
    for (const Item of [agentAppt, conv]) await doc.send(new PutCommand({ TableName: table, Item }));

    const result = await run(mapping, NEXT_DAY, { reset: true, confirmReset: async () => true });
    const items = await scan();
    expect(result.deleted).toBeGreaterThan(0);
    const days = [...new Set(byType(items, "SLOT").map((s) => clinicDateOf(String(s.startUtc))))].sort();
    expect(days[0]).toBe("2026-10-08"); // Oct 7's slots are gone
    expect(items.some((i) => i.SK === agentAppt.SK)).toBe(false);
    expect(items.some((i) => i.SK === conv.SK)).toBe(true);
    expectConsistentBookings(items);
    await doc.send(new DeleteCommand({ TableName: table, Key: { PK: conv.PK, SK: conv.SK } }));
    const fresh = await scan();
    expect(fresh).toHaveLength(result.written);
  });

  it("--reset keeps the profile and appointments of patients no longer in the mapping", async () => {
    await run(mappingFor(["pat-maria", "pat-walter"]), LATE_EVENING);
    const walterPk = `PATIENT#${SUBS["pat-walter"]}`;
    const walter = sorted((await scan()).filter((i) => i.PK === walterPk));
    expect(byType(walter, "PATIENT")).toHaveLength(1);
    expect(byType(walter, "APPOINTMENT")).toHaveLength(2);
    await run(mappingFor(["pat-maria"]), LATE_EVENING, { reset: true, confirmReset: async () => true });
    expect(sorted((await scan()).filter((i) => i.PK === walterPk))).toEqual(walter);
  });

  describe("runCli", () => {
    let dir: string;
    let mappingFile: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "seed-data-cli-"));
      mappingFile = join(dir, "m.json");
      writeFileSync(mappingFile, JSON.stringify(mappingFor(["pat-sofia"])));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const local = { DYNAMODB_ENDPOINT: ENDPOINT };
    /** (region, endpoint) each `dynamoClient` call received; every call gets the local test client. */
    let clientArgs: [string, string | undefined][];
    beforeEach(() => {
      clientArgs = [];
    });
    const deps = {
      now: LATE_EVENING,
      dynamoClient: (region: string, endpoint: string | undefined) => {
        clientArgs.push([region, endpoint]);
        return localClient();
      },
    };
    /** An SSM client stub: records the region and each parameter name; the pool parameter returns `pool`. */
    const fakeSsm = (pool: string) => {
      const asked: string[] = [];
      const regions: string[] = [];
      const ssmClient = (region: string) => {
        regions.push(region);
        return fakeClient<Pick<SSMClient, "send">>((input) => {
          asked.push(String(input.Name));
          return { Parameter: { Value: input.Name === "/sched/dev/data/table-name" ? table : pool } };
        }).client;
      };
      return { asked, regions, ssmClient };
    };

    it("locally, needs --table and seeds that table from the --mapping file", async () => {
      await expect(runCli(["--env", "dev"], local)).rejects.toThrow(/pass --table/);
      const out = await runCli(["--env", "dev", "--table", table, "--mapping", mappingFile], local, deps);
      expect(out.skipped).not.toContain("pat-sofia");
      expect(out.baseDate).toBe("2026-10-07"); // the injected clock, not the real one
      expect(clientArgs).toEqual([["us-east-1", ENDPOINT]]);
      expect((await scan()).some((i) => i.PK === `PATIENT#${SUBS["pat-sofia"]}`)).toBe(true);
    });

    it("on AWS, reads the table name and User Pool from the env's SSM parameters in us-east-1", async () => {
      const argv = ["--env", "dev", "--mapping", mappingFile];
      const other = fakeSsm("us-east-1_Other");
      await expect(runCli(argv, {}, { ...deps, ssmClient: other.ssmClient })).rejects.toThrow(/User Pool/);
      expect(await scan()).toHaveLength(0);
      const ok = fakeSsm(POOL);
      await runCli(argv, { DYNAMODB_ENDPOINT: "" }, { ...deps, ssmClient: ok.ssmClient });
      expect(ok.asked).toEqual(["/sched/dev/data/table-name", "/sched/dev/auth/user-pool-id"]);
      expect(ok.regions).toEqual(["us-east-1"]);
      expect(clientArgs).toEqual([["us-east-1", undefined]]);
      expect((await scan()).some((i) => i.PK === `PATIENT#${SUBS["pat-sofia"]}`)).toBe(true);
      const flagged = fakeSsm(POOL);
      await expect(
        runCli([...argv, "--table", "sched-other"], {}, { ...deps, ssmClient: flagged.ssmClient }),
      ).rejects.toThrow(/non-existent table|ResourceNotFound|Cannot do operations/);
      expect(flagged.asked).toEqual(["/sched/dev/auth/user-pool-id"]);
    });

    it("uses AWS_REGION for the SSM and DynamoDB clients when it is set", async () => {
      const ssm = fakeSsm(POOL);
      await runCli(
        ["--env", "dev", "--mapping", mappingFile],
        { AWS_REGION: "eu-west-1" },
        {
          ...deps,
          ssmClient: ssm.ssmClient,
        },
      );
      expect(ssm.regions).toEqual(["eu-west-1"]);
      expect(clientArgs).toEqual([["eu-west-1", undefined]]);
    });

    it("refuses --reset with no terminal and no --confirm, or a wrong --confirm", async () => {
      const base = ["--env", "dev", "--table", table, "--mapping", mappingFile, "--reset"];
      await expect(runCli(base, local, deps)).rejects.toThrow(/not confirmed/);
      await expect(runCli([...base, "--confirm", "other"], local, deps)).rejects.toThrow(/not confirmed/);
      await expect(runCli(base, local, { ...deps, ask: async () => "no" })).rejects.toThrow(/not confirmed/);
      expect(await scan()).toHaveLength(0);
      await runCli(base, local, { ...deps, ask: async () => table });
      expect((await scan()).length).toBeGreaterThan(0);
    });
  });
});
