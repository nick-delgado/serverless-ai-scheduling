/**
 * The access store without DynamoDB: the in-memory twin's rules, and the DynamoDB store's transactions and its
 * reading of a cancelled one through a fake `send` (owner decision r2/A-15). The race against real DynamoDB is in
 * `access-store.local.test.ts`.
 */
import type { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import type { Patient } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import {
  accessKeys,
  type AccessCaps,
  type AccessReservation,
  createDynamoAccessStore,
  createInMemoryAccessStore,
} from "../src/lib/access-store";
import { cancelled, fakeDoc as fakeAnyDoc, numberedReservation } from "./dynamo-fakes";

const RESERVATION: AccessReservation = {
  requestId: "11111111-1111-4111-8111-111111111111",
  username: "user-aaaaaaaa",
  day: "2026-10-20",
  accessExpiresAt: "2026-10-21T14:00:00Z",
};
const PATIENT: Patient = {
  patientId: "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01",
  firstName: "Noor",
  lastName: "Vance",
  dateOfBirth: "1990-08-09",
  createdAt: "2026-10-20T14:00:00Z",
};
const CAPS: AccessCaps = { daily: 10, active: 5 };

/** A fake document client that records the transactions it is sent. */
const fakeDoc = (outcome: () => unknown) => fakeAnyDoc<TransactWriteCommand>(outcome);

const reserveN = (n: number) => numberedReservation(n);

describe("createInMemoryAccessStore", () => {
  it("counts each reservation against the day and the registry", async () => {
    const store = createInMemoryAccessStore();
    await expect(store.reserve(reserveN(1), CAPS)).resolves.toEqual({ ok: true });
    await expect(store.reserve(reserveN(2), CAPS)).resolves.toEqual({ ok: true });
    expect(store.dailyCount("2026-10-20")).toBe(2);
    expect(store.dailyCount("2026-10-21")).toBe(0);
    expect(store.activeCount()).toBe(2);
  });

  it("refuses at the daily cap and writes nothing", async () => {
    const store = createInMemoryAccessStore();
    await store.reserve(reserveN(1), { daily: 1, active: 5 });
    await expect(store.reserve(reserveN(2), { daily: 1, active: 5 })).resolves.toEqual({
      ok: false,
      reason: "capped",
    });
    expect(store.issued).toHaveLength(1);
    expect(store.dailyCount("2026-10-20")).toBe(1);
  });

  it("refuses everything at a cap of 0, with nothing counted", async () => {
    const store = createInMemoryAccessStore();
    await expect(store.reserve(reserveN(1), { daily: 0, active: 5 })).resolves.toEqual({
      ok: false,
      reason: "capped",
    });
    await expect(store.reserve(reserveN(2), { daily: 5, active: 0 })).resolves.toEqual({
      ok: false,
      reason: "capped",
    });
    expect(store.issued).toHaveLength(0);
    expect(store.dailyCount("2026-10-20")).toBe(0);
  });

  it("refuses at the active cap, on any day, and counts nothing for the refused request", async () => {
    const store = createInMemoryAccessStore();
    await store.reserve(reserveN(1), { daily: 5, active: 1 });
    await expect(
      store.reserve({ ...reserveN(2), day: "2026-10-21" }, { daily: 5, active: 1 }),
    ).resolves.toEqual({ ok: false, reason: "capped" });
    expect(store.dailyCount("2026-10-21")).toBe(0);
  });

  it("records the sub, the final username and the profile on commit", async () => {
    const store = createInMemoryAccessStore();
    await store.reserve(RESERVATION, CAPS);
    await store.commit({ ...RESERVATION, username: "user-bbbbbbbb" }, PATIENT);
    expect(store.issued).toEqual([
      {
        requestId: RESERVATION.requestId,
        username: "user-bbbbbbbb",
        accessExpiresAt: RESERVATION.accessExpiresAt,
        sub: PATIENT.patientId,
      },
    ]);
    expect(store.patients).toEqual([PATIENT]);
  });

  it("refuses to commit without a reservation", async () => {
    await expect(createInMemoryAccessStore().commit(RESERVATION, PATIENT)).rejects.toThrow("no reservation");
  });
});

describe("createDynamoAccessStore", () => {
  it("reserves with one transaction: the day's counter, the active counter, then the registry entry", async () => {
    const { sent, doc } = fakeDoc(() => ({}));
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).resolves.toEqual({
      ok: true,
    });

    expect(sent).toHaveLength(1);
    const items = sent[0]?.input.TransactItems ?? [];
    expect(items).toHaveLength(3);
    expect(items[0]?.Update).toEqual({
      TableName: "t",
      Key: { PK: "ACCESS#COUNT", SK: "DAY#2026-10-20" },
      UpdateExpression: "ADD issued :one SET expiresAt = :exp, entityType = :type",
      ConditionExpression: "attribute_not_exists(issued) OR issued < :cap",
      ExpressionAttributeValues: {
        ":one": 1,
        ":cap": 10,
        ":exp": Date.parse("2026-10-23T00:00:00Z") / 1000,
        ":type": "ACCESS_DAILY_COUNTER",
      },
    });
    expect(items[1]?.Update).toEqual({
      TableName: "t",
      Key: { PK: "ACCESS#COUNT", SK: "ACTIVE" },
      UpdateExpression: "ADD active :one SET entityType = :type",
      ConditionExpression: "attribute_not_exists(active) OR active < :cap",
      ExpressionAttributeValues: { ":one": 1, ":cap": 5, ":type": "ACCESS_ACTIVE_COUNTER" },
    });
    expect(items[2]?.Put).toMatchObject({
      Item: {
        PK: "ACCESS#ISSUED",
        SK: `2026-10-21T14:00:00Z#${RESERVATION.requestId}`,
        username: "user-aaaaaaaa",
        requestId: RESERVATION.requestId,
        accessExpiresAt: "2026-10-21T14:00:00Z",
        entityType: "ACCESS_ISSUED",
      },
      ConditionExpression: "attribute_not_exists(PK)",
    });
  });

  it("expires the daily counter two days after its day ends, and gives the active counter no expiry", async () => {
    const { sent, doc } = fakeDoc(() => ({}));
    await createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS);
    const items = sent[0]?.input.TransactItems ?? [];
    // 2026-10-20 ends at 2026-10-21T00:00Z; plus two days is 2026-10-23T00:00Z.
    expect(items[0]?.Update?.ExpressionAttributeValues?.[":exp"]).toBe(
      Date.parse("2026-10-23T00:00:00Z") / 1000,
    );
    expect(items[1]?.Update?.UpdateExpression).not.toContain("expiresAt");
    expect(items[2]?.Put?.Item).not.toHaveProperty("expiresAt");
  });

  it("keeps the counters under ACCESS#, never under ENV", () => {
    expect(accessKeys.active().PK.startsWith("ACCESS#")).toBe(true);
    expect(accessKeys.daily("2026-10-20").PK.startsWith("ACCESS#")).toBe(true);
    expect(accessKeys.issued("x", "y").PK.startsWith("ACCESS#")).toBe(true);
  });

  it.each([
    ["the day's cap", ["ConditionalCheckFailed", "None", "None"]],
    ["the active cap", ["None", "ConditionalCheckFailed", "None"]],
    ["both caps", ["ConditionalCheckFailed", "ConditionalCheckFailed", "None"]],
    [
      "a cap and, on the other counter, only a conflict",
      ["ConditionalCheckFailed", "TransactionConflict", "None"],
    ],
    [
      "a cap and, on the other counter, only a conflict (other order)",
      ["TransactionConflict", "ConditionalCheckFailed", "None"],
    ],
  ])("reads %s as capped, and does not retry", async (_name, codes) => {
    const { sent, doc } = fakeDoc(() => {
      throw cancelled(...codes);
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).resolves.toEqual({
      ok: false,
      reason: "capped",
    });
    expect(sent).toHaveLength(1);
  });

  it("reads a failed counter as the cap even when the registry entry also failed", async () => {
    const { doc } = fakeDoc(() => {
      throw cancelled("ConditionalCheckFailed", "None", "ConditionalCheckFailed");
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).resolves.toEqual({
      ok: false,
      reason: "capped",
    });
  });

  it("throws, not conflict, when the registry entry exists and another item only conflicted", async () => {
    const { doc } = fakeDoc(() => {
      throw cancelled("TransactionConflict", "None", "ConditionalCheckFailed");
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).rejects.toBeInstanceOf(TransactionCanceledException);
  });

  it("reads a cancellation of conflicts alone as a conflict, with no retry loop", async () => {
    const { sent, doc } = fakeDoc(() => {
      throw cancelled("TransactionConflict", "None", "None");
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(sent).toHaveLength(1);
  });

  it("reads a conflict on the registry entry alone as a conflict too", async () => {
    const { doc } = fakeDoc(() => {
      throw cancelled("None", "None", "TransactionConflict");
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).resolves.toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("throws when the registry entry already exists, which a random request ID never causes", async () => {
    const { doc } = fakeDoc(() => {
      throw cancelled("None", "None", "ConditionalCheckFailed");
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).rejects.toBeInstanceOf(TransactionCanceledException);
  });

  it.each([["ThrottlingError"], ["ValidationError"]])(
    "throws a cancellation for %s, which is neither a cap nor a conflict",
    async (code) => {
      const { doc } = fakeDoc(() => {
        throw cancelled(code, "None", "None");
      });
      await expect(
        createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
      ).rejects.toBeInstanceOf(TransactionCanceledException);
    },
  );

  it("throws a cancellation that carries no reasons", async () => {
    const { doc } = fakeDoc(() => {
      throw new TransactionCanceledException({ message: "x", $metadata: {} });
    });
    await expect(
      createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS),
    ).rejects.toBeInstanceOf(TransactionCanceledException);
  });

  it("throws any other error", async () => {
    const { doc } = fakeDoc(() => {
      throw new Error("network down");
    });
    await expect(createDynamoAccessStore({ tableName: "t", doc }).reserve(RESERVATION, CAPS)).rejects.toThrow(
      "network down",
    );
  });

  it("commits the profile and the entry's sub and username in one transaction", async () => {
    const { sent, doc } = fakeDoc(() => ({}));
    await createDynamoAccessStore({ tableName: "t", doc }).commit(
      { ...RESERVATION, username: "user-bbbbbbbb" },
      PATIENT,
    );

    expect(sent).toHaveLength(1);
    const items = sent[0]?.input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Put).toMatchObject({
      Item: { PK: `PATIENT#${PATIENT.patientId}`, SK: "PROFILE", entityType: "PATIENT", firstName: "Noor" },
      ConditionExpression: "attribute_not_exists(PK)",
    });
    expect(items[1]?.Update).toMatchObject({
      Key: { PK: "ACCESS#ISSUED", SK: `2026-10-21T14:00:00Z#${RESERVATION.requestId}` },
      UpdateExpression: "SET #sub = :sub, username = :username",
      ExpressionAttributeNames: { "#sub": "sub" },
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":sub": PATIENT.patientId, ":username": "user-bbbbbbbb" },
    });
  });
});

describe("the expiry job's side of the in-memory store", () => {
  it("lists entries at or before the time, oldest first, as copies without the sub's absence filled in", async () => {
    const store = createInMemoryAccessStore();
    await store.reserve({ ...reserveN(2), accessExpiresAt: "2026-10-21T13:00:00Z" }, CAPS);
    await store.reserve({ ...reserveN(1), accessExpiresAt: "2026-10-21T12:00:00Z" }, CAPS);
    await store.reserve({ ...reserveN(3), accessExpiresAt: "2026-10-21T13:00:01Z" }, CAPS);
    const due = await store.listExpired("2026-10-21T13:00:00Z");
    expect(due.map((e) => e.username)).toEqual(["user-00000001", "user-00000002"]);
    const [first] = due;
    if (first) first.username = "changed";
    expect(store.issued[1]?.username).toBe("user-00000001");
  });

  it("releases an entry once, taking its active place with it, and says gone the second time", async () => {
    const store = createInMemoryAccessStore();
    await store.reserve(reserveN(1), CAPS);
    await store.reserve(reserveN(2), CAPS);
    const [entry] = await store.listExpired("2026-10-21T14:00:00Z");
    if (!entry) throw new Error("no entry");
    await expect(store.release(entry)).resolves.toEqual({ ok: true });
    expect(store.activeCount()).toBe(1);
    expect(store.issued.map((e) => e.username)).toEqual(["user-00000002"]);
    await expect(store.release(entry)).resolves.toEqual({ ok: false, reason: "gone" });
    expect(store.activeCount()).toBe(1);
  });
});

describe("createDynamoAccessStore's expiry side", () => {
  const ENTRY = {
    requestId: RESERVATION.requestId,
    username: "user-aaaaaaaa",
    accessExpiresAt: "2026-10-21T14:00:00Z",
    sub: PATIENT.patientId,
  };

  it("queries the registry's partition up to the time, consistently, and follows the pages", async () => {
    const pages = [
      { Items: [{ ...ENTRY, PK: "ACCESS#ISSUED" }], LastEvaluatedKey: { PK: "ACCESS#ISSUED", SK: "k1" } },
      { Items: [{ requestId: "r2", username: "user-bbbbbbbb", accessExpiresAt: "2026-10-21T14:30:00Z" }] },
    ];
    const { sent, doc } = fakeAnyDoc<{ input: Record<string, unknown> }>(() => pages.shift());

    const due = await createDynamoAccessStore({ tableName: "t", doc }).listExpired("2026-10-21T15:00:00Z");

    expect(due).toEqual([
      ENTRY,
      { requestId: "r2", username: "user-bbbbbbbb", accessExpiresAt: "2026-10-21T14:30:00Z" },
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.input).toMatchObject({
      TableName: "t",
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk AND SK <= :last",
      ExpressionAttributeValues: { ":pk": "ACCESS#ISSUED", ":last": "2026-10-21T15:00:00Z#~" },
    });
    expect(sent[1]?.input.ExclusiveStartKey).toEqual({ PK: "ACCESS#ISSUED", SK: "k1" });
  });

  it("removes the entry and takes one off the active counter in one transaction, each guarded", async () => {
    const { sent, doc } = fakeDoc(() => ({}));
    await expect(createDynamoAccessStore({ tableName: "t", doc }).release(ENTRY)).resolves.toEqual({
      ok: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input.TransactItems).toEqual([
      {
        Delete: {
          TableName: "t",
          Key: { PK: "ACCESS#ISSUED", SK: `2026-10-21T14:00:00Z#${RESERVATION.requestId}` },
          ConditionExpression: "attribute_exists(PK)",
        },
      },
      {
        Update: {
          TableName: "t",
          Key: { PK: "ACCESS#COUNT", SK: "ACTIVE" },
          UpdateExpression: "ADD active :minusOne",
          ConditionExpression: "active >= :one",
          ExpressionAttributeValues: { ":minusOne": -1, ":one": 1 },
        },
      },
    ]);
  });

  it("reads a failed entry condition as gone: the entry was released already", async () => {
    const { doc } = fakeDoc(() => {
      throw cancelled("ConditionalCheckFailed", "None");
    });
    await expect(createDynamoAccessStore({ tableName: "t", doc }).release(ENTRY)).resolves.toEqual({
      ok: false,
      reason: "gone",
    });
  });

  it.each([
    ["a counter already at 0", cancelled("None", "ConditionalCheckFailed")],
    ["a conflict", cancelled("TransactionConflict", "None")],
    ["any other error", new Error("network down")],
  ])("throws on %s, so the entry stays for the next run", async (_name, failure) => {
    const { doc } = fakeDoc(() => {
      throw failure;
    });
    await expect(createDynamoAccessStore({ tableName: "t", doc }).release(ENTRY)).rejects.toBe(failure);
  });
});
