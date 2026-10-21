/**
 * The expiry job against DynamoDB Local (#357 part 2): the registry entry removed and the active counter released in
 * one transaction, the account's data deleted (profile, appointments, conversations with their messages, escalation
 * and traces, turn counters), the slots it held freed, and the failure paths: a delete or a slot release that fails
 * part-way leaves the account to be finished by the next run. The fixture patients, another temporary account and a
 * slot held by someone else are checked untouched. Skipped locally without DynamoDB Local; required in CI.
 */
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { ConversationMessage, Patient, PatientId, Slot, SlotId } from "@sched/contracts";
import { clinicDateOf, FrozenClock, type Repositories } from "@sched/tools";
import {
  createDocumentClient,
  createDynamoRepositories,
  keys,
  openSlotGsi1,
  writeSeed,
} from "@sched/tools/dynamo";
import { buildClinicFixture, FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDynamoAccessStore, type AccessReservation } from "../src/lib/access-store";
import { createAccountData } from "../src/lib/account-data";
import { createDynamoTurnStore } from "../src/lib/dynamo-turn-store";
import { expireAccess, type ExpireDeps } from "../src/lib/expire-access";
import { dynamoLocalAvailable, localClient, tableFactory } from "./dynamo-local";

const NOW = "2026-10-05T12:00:00Z";
const DUE = "2026-10-05T11:00:00Z";
const LATER = "2026-10-06T11:00:00Z";
const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const CAPS = { daily: 100, active: 100 };
const CONV = "00000000-0000-4000-8000-00000000c001";
const TURN = "00000000-0000-4000-8000-00000000d001";

const available = await dynamoLocalAvailable();
const client = localClient();
const tables = tableFactory(client);
const doc = createDocumentClient(client);

afterAll(async () => {
  if (available) await tables.dropAll();
  client.destroy();
});

const guid = (n: number): PatientId => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const reservation = (n: number, accessExpiresAt: string): AccessReservation => ({
  requestId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  username: `user-${String(n).padStart(8, "0")}`,
  day: "2026-10-05",
  accessExpiresAt,
});
const profile = (patientId: PatientId): Patient => ({
  patientId,
  firstName: "Noor",
  lastName: "Vance",
  dateOfBirth: "1990-08-09",
  createdAt: "2026-10-04T12:00:00Z",
});

describe.skipIf(!available)("the expiry job (DynamoDB Local)", () => {
  let tableName: string;
  let repos: Repositories;
  let slots: readonly Slot[];
  let deps: ExpireDeps;
  let pool: Map<string, string>;
  const store = () => createDynamoAccessStore({ tableName, doc });

  /** Every item of a partition, as stored. */
  const partition = async (PK: string) =>
    (
      await doc.send(
        new QueryCommand({
          TableName: tableName,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": PK },
        }),
      )
    ).Items ?? [];
  const get = async (Key: { PK: string; SK: string }) =>
    (await doc.send(new GetCommand({ TableName: tableName, Key, ConsistentRead: true }))).Item;
  const counter = async (SK: string) => (await get({ PK: "ACCESS#COUNT", SK }))?.active as number | undefined;
  const registry = async () => (await partition("ACCESS#ISSUED")).map((i) => i.username as string);
  const openSlots = (): Slot[] => slots.filter((s) => s.status === "OPEN" && s.providerId === "prov_lee");

  /** Issues an account the way the request function does: reserve, then commit with the profile. */
  async function issue(n: number, accessExpiresAt: string): Promise<PatientId> {
    const r = reservation(n, accessExpiresAt);
    await store().reserve(r, CAPS);
    const patientId = guid(n);
    await store().commit(r, profile(patientId));
    pool.set(r.username, patientId);
    return patientId;
  }

  /** What an account that chatted, booked and escalated leaves behind. */
  async function use(patientId: PatientId, slot: Slot): Promise<void> {
    const booked = await repos.appointments.book({ patientId, slotId: slot.slotId, reason: "Annual check" });
    if (!booked.ok) throw new Error("setup: book failed");
    const base = { conversationId: CONV, turnId: TURN, createdAt: "2026-10-05T11:30:00.000Z" };
    const messages: ConversationMessage[] = [
      { ...base, seq: 0, role: "user", content: [{ type: "text", text: "Hello" }] },
      { ...base, seq: 1, role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];
    await repos.conversations.append(patientId, messages);
    await repos.escalations.record({
      patientId,
      conversationId: CONV,
      reason: "patient_requested",
      summary: "Patient asked to speak with a person.",
    });
    const turns = createDynamoTurnStore({ tableName, doc });
    await turns.consumeDailyTurn(patientId, "2026-10-05", { patient: 50, env: 200 });
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: `CONV#${CONV}`, SK: `TRACE#${TURN}`, entityType: "TURN_TRACE", patientId, trace: "{}" },
      }),
    );
  }

  beforeEach(async () => {
    tableName = await tables.create();
    const seed = buildClinicFixture();
    await writeSeed({ tableName, client, seed });
    slots = seed.slots;
    repos = createDynamoRepositories({ tableName, client, clock: new FrozenClock(NOW) });
    pool = new Map();
    deps = {
      store: store(),
      admin: {
        findSub: (u) => Promise.resolve(pool.get(u)),
        globalSignOut: () => Promise.resolve(),
        deleteUser: (u) => {
          pool.delete(u);
          return Promise.resolve();
        },
      },
      data: createAccountData({ tableName, doc }),
      clock: new FrozenClock(NOW),
    };
  });

  it("deletes the account's data, frees its slots, and releases the registry entry and its active place", async () => {
    const gone = await issue(1, DUE);
    const [first, second] = openSlots();
    if (!first || !second) throw new Error("setup: no open slots");
    await use(gone, first);
    await repos.appointments.book({ patientId: gone, slotId: second.slotId, reason: "Follow up" });
    expect(await partition(`PATIENT#${gone}`)).not.toHaveLength(0);
    expect(await partition(`CONV#${CONV}`)).toHaveLength(4); // two messages, ESC, TRACE
    const mariaBefore = await partition(`PATIENT#${MARIA}`);
    const kept = await issue(2, LATER);
    const keptBefore = await partition(`PATIENT#${kept}`);

    const summary = await expireAccess(deps);

    expect(summary).toEqual({ asOf: NOW, due: 1, expired: 1, skipped: 0, failed: 0 });
    expect(await partition(`PATIENT#${gone}`)).toEqual([]);
    expect(await partition(`CONV#${CONV}`)).toEqual([]);
    expect(pool.has("user-00000001")).toBe(false);
    for (const slot of [first, second]) {
      const freed = await get(keys.slot(slot.providerId, slot.startUtc));
      expect(freed).toMatchObject({
        status: "OPEN",
        ...openSlotGsi1(slot.specialty, slot.providerId, slot.startUtc),
      });
      expect(freed).not.toHaveProperty("appointmentId");
    }
    const open = await repos.slots.listOpenBySpecialtyAndDay(first.specialty, clinicDateOf(first.startUtc));
    expect(open.map((s) => s.slotId)).toContain(first.slotId);
    expect(await registry()).toEqual(["user-00000002"]);
    expect(await counter("ACTIVE")).toBe(1);
    expect(await partition(`PATIENT#${MARIA}`)).toEqual(mariaBefore);
    expect(await partition(`PATIENT#${kept}`)).toEqual(keptBefore);
    expect(pool.has("user-00000002")).toBe(true);
  });

  it("makes the freed place available again at the active cap", async () => {
    await issue(1, DUE);
    const atCap = { daily: 100, active: 1 };
    expect(await store().reserve(reservation(2, LATER), atCap)).toEqual({ ok: false, reason: "capped" });
    await expireAccess(deps);
    expect(await store().reserve(reservation(2, LATER), atCap)).toEqual({ ok: true });
    expect(await counter("ACTIVE")).toBe(1);
  });

  it("does nothing a second time: no due entries, and the counter isn't decremented twice", async () => {
    await issue(1, DUE);
    await issue(2, LATER);
    await expireAccess(deps);
    expect(await expireAccess(deps)).toMatchObject({ due: 0, expired: 0 });
    expect(await counter("ACTIVE")).toBe(1);
  });

  it("releases an entry once: a second release finds it gone and takes nothing off the counter", async () => {
    await issue(1, DUE);
    await issue(2, LATER);
    const [entry] = await store().listExpired(NOW);
    if (!entry) throw new Error("setup: no entry");
    expect(await store().release(entry)).toEqual({ ok: true });
    expect(await store().release(entry)).toEqual({ ok: false, reason: "gone" });
    expect(await counter("ACTIVE")).toBe(1);
    expect(await registry()).toEqual(["user-00000002"]);
  });

  it("throws, leaving the entry, when the active counter is already 0", async () => {
    await issue(1, DUE);
    await doc.send(
      new PutCommand({ TableName: tableName, Item: { PK: "ACCESS#COUNT", SK: "ACTIVE", active: 0 } }),
    );
    const [entry] = await store().listExpired(NOW);
    if (!entry) throw new Error("setup: no entry");
    await expect(store().release(entry)).rejects.toThrow();
    expect(await registry()).toEqual(["user-00000001"]);
    expect(await counter("ACTIVE")).toBe(0);
  });

  it("lists only entries at or before the time, oldest first, from the registry's own partition", async () => {
    await issue(3, "2026-10-05T10:00:00Z");
    await issue(1, NOW);
    await issue(2, "2026-10-05T12:00:01Z");
    const due = await store().listExpired(NOW);
    expect(due.map((e) => e.username)).toEqual(["user-00000003", "user-00000001"]);
    expect(due[0]).toEqual({
      requestId: reservation(3, "").requestId,
      username: "user-00000003",
      accessExpiresAt: "2026-10-05T10:00:00Z",
      sub: guid(3),
    });
  });

  it("lists an entry that never got a sub without one, and releases it without touching a user", async () => {
    const r = reservation(1, DUE);
    await store().reserve(r, CAPS);
    pool.set(r.username, "someone-else");
    expect(await expireAccess(deps)).toMatchObject({ due: 1, expired: 1 });
    expect(pool.has(r.username)).toBe(true);
    expect(await registry()).toEqual([]);
    expect(await counter("ACTIVE")).toBe(0);
  });

  it("frees a slot only for the appointment that holds it: a cancelled appointment, or one whose slot another patient holds, only goes", async () => {
    const gone = await issue(1, DUE);
    const [mine, theirs] = openSlots();
    if (!mine || !theirs) throw new Error("setup: no open slots");
    // Someone else holds `theirs`.
    await repos.appointments.book({ patientId: MARIA, slotId: theirs.slotId, reason: "Check" });
    const appt = (id: string, slotId: SlotId, slot: Slot, status: string) =>
      doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...keys.appointment(gone, id),
            entityType: "APPOINTMENT",
            appointmentId: id,
            patientId: gone,
            providerId: slot.providerId,
            slotId,
            specialty: slot.specialty,
            startUtc: slot.startUtc,
            endUtc: slot.endUtc,
            status,
            reason: "x",
            createdAt: NOW,
            updatedAt: NOW,
          },
        }),
      );
    await appt("appt_cancelled01", theirs.slotId, theirs, "CANCELLED");
    await appt("appt_stale000001", theirs.slotId, theirs, "BOOKED");
    await repos.appointments.book({ patientId: gone, slotId: mine.slotId, reason: "Mine" });
    const before = await get(keys.slot(theirs.providerId, theirs.startUtc));
    expect(before).toMatchObject({ status: "BOOKED" });

    await expireAccess(deps);

    expect(await partition(`PATIENT#${gone}`)).toEqual([]);
    expect(await get(keys.slot(theirs.providerId, theirs.startUtc))).toEqual(before);
    expect(await get(keys.slot(mine.providerId, mine.startUtc))).toMatchObject({ status: "OPEN" });
  });

  it("never creates a slot: an appointment whose slot item doesn't exist is deleted alone", async () => {
    const gone = await issue(1, DUE);
    const [slot] = openSlots();
    if (!slot) throw new Error("setup: no open slots");
    await repos.appointments.book({ patientId: gone, slotId: slot.slotId, reason: "Mine" });
    await doc.send(
      new DeleteCommand({ TableName: tableName, Key: keys.slot(slot.providerId, slot.startUtc) }),
    );
    const before = (await doc.send(new ScanCommand({ TableName: tableName, Select: "COUNT" }))).Count ?? 0;

    expect(await expireAccess(deps)).toMatchObject({ expired: 1, failed: 0 });

    expect(await get(keys.slot(slot.providerId, slot.startUtc))).toBeUndefined();
    expect(await partition(`PATIENT#${gone}`)).toEqual([]);
    expect(before).toBeGreaterThan(0);
  });

  describe("when a call fails part-way", () => {
    /** A document client that throws once for the first command `fails` says yes to, then works. */
    const flaky = (
      fails: (command: { constructor: { name: string }; input: Record<string, unknown> }) => boolean,
    ) => {
      let thrown = false;
      return {
        send: (command: never) => {
          if (!thrown && fails(command)) {
            thrown = true;
            return Promise.reject(new Error("throttled"));
          }
          return doc.send(command);
        },
      };
    };

    it("a failed delete after the conversation is gone leaves the entry and the profile, and the next run finishes", async () => {
      const gone = await issue(1, DUE);
      const [slot] = openSlots();
      if (!slot) throw new Error("setup: no open slots");
      await use(gone, slot);
      const breaking = createAccountData({
        tableName,
        doc: flaky(
          (c) =>
            c.constructor.name === "DeleteCommand" &&
            String((c.input.Key as { SK: string }).SK).startsWith("TURNS#"),
        ),
      });

      expect(await expireAccess({ ...deps, data: breaking })).toMatchObject({ expired: 0, failed: 1 });

      expect(await registry()).toEqual(["user-00000001"]);
      expect(await counter("ACTIVE")).toBe(1);
      expect(await partition(`CONV#${CONV}`)).toEqual([]);
      expect(await get(keys.patient(gone))).toBeDefined();

      expect(await expireAccess(deps)).toMatchObject({ expired: 1, failed: 0 });
      expect(await partition(`PATIENT#${gone}`)).toEqual([]);
      expect(await registry()).toEqual([]);
      expect(await counter("ACTIVE")).toBe(0);
    });

    it("a failed slot release leaves the appointment and the slot as they were, and the next run frees it", async () => {
      const gone = await issue(1, DUE);
      const [slot] = openSlots();
      if (!slot) throw new Error("setup: no open slots");
      await use(gone, slot);
      const breaking = createAccountData({
        tableName,
        doc: flaky((c) => c.constructor.name === "TransactWriteCommand"),
      });

      expect(await expireAccess({ ...deps, data: breaking })).toMatchObject({ failed: 1 });
      expect(await get(keys.slot(slot.providerId, slot.startUtc))).toMatchObject({ status: "BOOKED" });
      expect(await partition(`PATIENT#${gone}`)).not.toEqual([]);

      expect(await expireAccess(deps)).toMatchObject({ expired: 1, failed: 0 });
      expect(await get(keys.slot(slot.providerId, slot.startUtc))).toMatchObject({ status: "OPEN" });
    });

    it("a failed user delete keeps every item, and the next run deletes the user and the data", async () => {
      const gone = await issue(1, DUE);
      let fail = true;
      const admin: ExpireDeps["admin"] = {
        ...deps.admin,
        deleteUser: (u) => {
          if (fail) return Promise.reject(new Error("throttled"));
          pool.delete(u);
          return Promise.resolve();
        },
      };

      expect(await expireAccess({ ...deps, admin })).toMatchObject({ failed: 1 });
      expect(await get(keys.patient(gone))).toBeDefined();
      expect(await registry()).toEqual(["user-00000001"]);

      fail = false;
      expect(await expireAccess({ ...deps, admin })).toMatchObject({ expired: 1 });
      expect(await get(keys.patient(gone))).toBeUndefined();
      expect(pool.size).toBe(0);
    });
  });

  it("keeps the registry and the active counter in step when a release and a new reservation run together", async () => {
    await issue(1, DUE);
    await issue(2, LATER);
    const [entry] = await store().listExpired(NOW);
    if (!entry) throw new Error("setup: no entry");
    const [released, reserved] = await Promise.allSettled([
      store().release(entry),
      store().reserve(reservation(3, LATER), CAPS),
    ]);
    // On the real service one of them may be cancelled by a conflict instead (DynamoDB Local reports none).
    expect(released.status).toBe("fulfilled");
    expect(reserved.status).toBe("fulfilled");
    expect((await registry()).sort()).toEqual(["user-00000002", "user-00000003"]);
    expect(await counter("ACTIVE")).toBe(2);
  });
});
