/**
 * `createAccountData` through a fake document client (#357 part 2): the shape of each call, the order of the deletes,
 * and the slot release's handling of a slot that changed. The deletes against real tables are in
 * `expire-access.local.test.ts`.
 */
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import { createAccountData } from "../src/lib/account-data";
import { cancelled } from "./dynamo-fakes";

const SUB = "22222222-2222-4222-8222-000000000001";
const CONV = "00000000-0000-4000-8000-00000000c001";
const SLOT = "slot_lee_20261007T1400Z";
const SLOT2 = "slot_lee_20261008T1400Z";
const META = { PK: `PATIENT#${SUB}`, SK: `CONV#2026-10-05T11:30:00.000Z#${CONV}`, conversationId: CONV };

type Key = { PK: string; SK: string };
/** The parts of a command's input these tests read. */
type Cmd = {
  constructor: { name: string };
  input: {
    TableName: string;
    ConsistentRead: boolean;
    Key: Key;
    ExpressionAttributeValues: Record<string, string>;
    ExclusiveStartKey?: { at: number };
    TransactItems: { Update: { Key: Key } }[];
  };
};

/** A fake table: partitions as lists of items, appointments as stored, and a script for the transaction. */
function fake(opts: {
  partitions?: Record<string, Record<string, unknown>[]>;
  appts?: Record<string, Record<string, unknown>[]>;
  transact?: (n: number) => unknown;
  pages?: boolean;
}) {
  const log: string[] = [];
  const sent: Cmd[] = [];
  let transacts = 0;
  const apptReads = new Map<string, number>();
  const doc = {
    send: (command: Cmd) => {
      sent.push(command);
      const input = command.input;
      if (command instanceof QueryCommand || command.constructor.name === "QueryCommand") {
        const pk = input.ExpressionAttributeValues[":pk"] as string;
        const all = opts.partitions?.[pk] ?? [];
        if (opts.pages) {
          const from = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.at) : 0;
          const page = all.slice(from, from + 1);
          const next = from + 1 < all.length ? { at: from + 1 } : undefined;
          return Promise.resolve({ Items: page, LastEvaluatedKey: next });
        }
        return Promise.resolve({ Items: all });
      }
      if (command instanceof GetCommand) {
        const key = `${input.Key.PK}|${input.Key.SK}`;
        const n = apptReads.get(key) ?? 0;
        apptReads.set(key, n + 1);
        const versions = opts.appts?.[key] ?? [];
        return Promise.resolve({ Item: versions[Math.min(n, versions.length - 1)] });
      }
      if (command instanceof TransactWriteCommand) {
        log.push("transact");
        const out = opts.transact?.(transacts++);
        if (out instanceof Error) return Promise.reject(out);
        return Promise.resolve({});
      }
      if (command instanceof DeleteCommand) {
        log.push(`delete ${input.Key.PK} ${input.Key.SK}`);
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
    },
  };
  return { doc: doc as never, log, sent };
}

const apptItem = (over: Record<string, unknown> = {}) => ({
  PK: `PATIENT#${SUB}`,
  SK: "APPT#appt_aaaaaaaaaa",
  appointmentId: "appt_aaaaaaaaaa",
  slotId: SLOT,
  specialty: "family_medicine",
  status: "BOOKED",
  ...over,
});
const APPT_KEY = `PATIENT#${SUB}|APPT#appt_aaaaaaaaaa`;

describe("createAccountData", () => {
  it("deletes each conversation's own items, then its meta item, then the appointments, the turn counters and last the profile", async () => {
    const { doc, log } = fake({
      partitions: {
        [`PATIENT#${SUB}`]: [
          { PK: `PATIENT#${SUB}`, SK: "APPT#appt_aaaaaaaaaa" },
          { PK: `PATIENT#${SUB}`, SK: "PROFILE" },
          META,
          { PK: `PATIENT#${SUB}`, SK: "TURNS#2026-10-05" },
        ],
        [`CONV#${CONV}`]: [
          { PK: `CONV#${CONV}`, SK: "ESC" },
          { PK: `CONV#${CONV}`, SK: "MSG#000000" },
          { PK: `CONV#${CONV}`, SK: "TRACE#t1" },
        ],
      },
      appts: { [APPT_KEY]: [apptItem({ status: "CANCELLED" })] },
    });

    const out = await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);

    expect(log).toEqual([
      `delete CONV#${CONV} ESC`,
      `delete CONV#${CONV} MSG#000000`,
      `delete CONV#${CONV} TRACE#t1`,
      `delete ${META.PK} ${META.SK}`,
      `delete PATIENT#${SUB} APPT#appt_aaaaaaaaaa`,
      `delete PATIENT#${SUB} TURNS#2026-10-05`,
      `delete PATIENT#${SUB} PROFILE`,
    ]);
    expect(out).toEqual({ items: 7, slotsFreed: 0 });
  });

  it("reads every partition consistently and follows its pages", async () => {
    const { doc, log, sent } = fake({
      pages: true,
      partitions: {
        [`PATIENT#${SUB}`]: [
          { PK: `PATIENT#${SUB}`, SK: "TURNS#2026-10-05" },
          { PK: `PATIENT#${SUB}`, SK: "TURNS#2026-10-06" },
          { PK: `PATIENT#${SUB}`, SK: "PROFILE" },
        ],
      },
    });
    await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);
    expect(log).toEqual([
      `delete PATIENT#${SUB} TURNS#2026-10-05`,
      `delete PATIENT#${SUB} TURNS#2026-10-06`,
      `delete PATIENT#${SUB} PROFILE`,
    ]);
    const queries = sent.filter((c) => c instanceof QueryCommand);
    expect(queries).toHaveLength(3);
    expect(queries.map((q) => q.input.ConsistentRead)).toEqual([true, true, true]);
    expect(queries.map((q) => q.input.TableName)).toEqual(["t", "t", "t"]);
  });

  it("deletes more than ten items in batches of ten at a time, all of them", async () => {
    const msgs = Array.from({ length: 23 }, (_, i) => ({
      PK: `CONV#${CONV}`,
      SK: `MSG#${String(i).padStart(6, "0")}`,
    }));
    let live = 0;
    let peak = 0;
    const { doc, log } = fake({ partitions: { [`PATIENT#${SUB}`]: [META], [`CONV#${CONV}`]: msgs } });
    const slow = {
      send: async (c: Cmd) => {
        if (c instanceof DeleteCommand) {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
        }
        return (doc as { send: (c: Cmd) => Promise<unknown> }).send(c);
      },
    };
    const out = await createAccountData({ tableName: "t", doc: slow as never }).deleteAccount(SUB);
    expect(log.filter((l) => l.includes(`CONV#${CONV} MSG`))).toHaveLength(23);
    expect(peak).toBe(10);
    expect(out.items).toBe(24); // 23 messages and the meta item (the profile wasn't there)
  });

  it("skips the conversation's partition when the meta item names no conversation, and still deletes the meta item", async () => {
    const { doc, log } = fake({
      partitions: { [`PATIENT#${SUB}`]: [{ PK: `PATIENT#${SUB}`, SK: "CONV#x#y" }] },
    });
    await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);
    expect(log).toEqual([`delete PATIENT#${SUB} CONV#x#y`, `delete PATIENT#${SUB} PROFILE`]);
  });

  it("deletes other items of the patient's partition too, before the profile", async () => {
    const { doc, log } = fake({
      partitions: {
        [`PATIENT#${SUB}`]: [
          { PK: `PATIENT#${SUB}`, SK: "OTHER#1" },
          { PK: `PATIENT#${SUB}`, SK: "PROFILE" },
        ],
      },
    });
    await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);
    expect(log).toEqual([`delete PATIENT#${SUB} OTHER#1`, `delete PATIENT#${SUB} PROFILE`]);
  });

  it.each(["", "maria.santos", "PATIENT#x", "../x"])(
    "refuses %j as a patient ID before any call",
    async (bad) => {
      const { doc, sent } = fake({});
      await expect(createAccountData({ tableName: "t", doc }).deleteAccount(bad)).rejects.toThrow();
      expect(sent).toEqual([]);
    },
  );

  describe("a BOOKED appointment", () => {
    const withAppt = (extra: Parameters<typeof fake>[0] = {}) =>
      fake({
        partitions: { [`PATIENT#${SUB}`]: [{ PK: `PATIENT#${SUB}`, SK: "APPT#appt_aaaaaaaaaa" }] },
        appts: { [APPT_KEY]: [apptItem()] },
        ...extra,
      });

    it("goes in one transaction with its slot: back to OPEN with its GSI1 keys, only if the slot still holds it", async () => {
      const { doc, log, sent } = withAppt();
      const out = await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);

      expect(out.slotsFreed).toBe(1);
      const tx = sent.find((c) => c.constructor.name === "TransactWriteCommand");
      expect(tx?.input.TransactItems).toEqual([
        {
          Update: {
            TableName: "t",
            Key: { PK: "PROVIDER#prov_lee", SK: "SLOT#2026-10-07T14:00:00Z" },
            UpdateExpression: "SET #status = :open, GSI1PK = :gpk, GSI1SK = :gsk REMOVE #appt",
            ConditionExpression: "#appt = :id AND #status = :booked",
            ExpressionAttributeNames: { "#status": "status", "#appt": "appointmentId" },
            ExpressionAttributeValues: {
              ":open": "OPEN",
              ":booked": "BOOKED",
              ":id": "appt_aaaaaaaaaa",
              ":gpk": "OPEN#family_medicine#2026-10-07",
              ":gsk": "2026-10-07T14:00:00Z#prov_lee",
            },
          },
        },
        { Delete: { TableName: "t", Key: { PK: `PATIENT#${SUB}`, SK: "APPT#appt_aaaaaaaaaa" } } },
      ]);
      // The transaction deletes the appointment, so no separate delete of it follows.
      expect(log.filter((l) => l.includes("APPT#"))).toEqual([]);
    });

    it("is deleted alone when its slot no longer holds it, and the slot is left as it is", async () => {
      const { doc, log } = withAppt({ transact: () => cancelled("ConditionalCheckFailed", "None") });
      const out = await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);
      expect(out.slotsFreed).toBe(0);
      expect(log).toEqual([
        "transact",
        `delete PATIENT#${SUB} APPT#appt_aaaaaaaaaa`,
        `delete PATIENT#${SUB} PROFILE`,
      ]);
    });

    it("is released again in its new slot when a reschedule moved it between the read and the transaction", async () => {
      const { doc, sent, log } = withAppt({
        appts: { [APPT_KEY]: [apptItem(), apptItem({ slotId: SLOT2 })] },
        transact: (n) => (n === 0 ? cancelled("ConditionalCheckFailed", "None") : undefined),
      });
      const out = await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);
      expect(out.slotsFreed).toBe(1);
      const txs = sent.filter((c) => c.constructor.name === "TransactWriteCommand");
      expect(txs.map((t) => t.input.TransactItems[0]?.Update.Key.SK)).toEqual([
        "SLOT#2026-10-07T14:00:00Z",
        "SLOT#2026-10-08T14:00:00Z",
      ]);
      expect(log).toEqual(["transact", "transact", `delete PATIENT#${SUB} PROFILE`]);
    });

    it("gives up loudly when the slot keeps changing, leaving the appointment and the profile", async () => {
      const slots = [1, 2, 3, 4, 5, 6].map((d) => apptItem({ slotId: `slot_lee_2026100${d}T1400Z` }));
      const { doc, log } = withAppt({
        appts: { [APPT_KEY]: slots },
        transact: () => cancelled("ConditionalCheckFailed", "None"),
      });
      await expect(createAccountData({ tableName: "t", doc }).deleteAccount(SUB)).rejects.toThrow(
        "its slot kept changing under the release",
      );
      expect(log).toEqual(["transact", "transact", "transact", "transact", "transact"]);
    });

    it("rethrows a conflict or any other failure of the transaction, deleting nothing of the appointment or the profile", async () => {
      for (const failure of [cancelled("TransactionConflict", "None"), new Error("throttled")]) {
        const { doc, log } = withAppt({ transact: () => failure });
        await expect(createAccountData({ tableName: "t", doc }).deleteAccount(SUB)).rejects.toThrow();
        expect(log).toEqual(["transact"]);
      }
    });

    it("is deleted alone, no slot touched, when it is not BOOKED, has no readable slot, or is already gone", async () => {
      for (const [item, deletes] of [
        [apptItem({ status: "COMPLETED" }), 2],
        [apptItem({ slotId: "garbage" }), 2],
        [undefined, 1],
      ] as const) {
        const { doc, log, sent } = withAppt({ appts: { [APPT_KEY]: item ? [item] : [] } });
        const out = await createAccountData({ tableName: "t", doc }).deleteAccount(SUB);
        expect(out.slotsFreed).toBe(0);
        expect(sent.some((c) => c.constructor.name === "TransactWriteCommand")).toBe(false);
        expect(log).toHaveLength(deletes);
      }
    });
  });
});
