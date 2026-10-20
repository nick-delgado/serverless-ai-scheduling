/**
 * The access store against DynamoDB Local (#357, owner decisions r1/Q-3 (a) and r2/A-15): both caps' boundaries,
 * a refused request counting nothing, and concurrent requests for the last place. This is the evidence for the
 * condition path only: DynamoDB Local rarely cancels for a conflict, so the conflict path is the fake-`send` test in
 * `access-store.test.ts`. Skipped locally without DynamoDB Local; required in CI (see `dynamo-local.ts`).
 */
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Patient } from "@sched/contracts";
import { createDocumentClient } from "@sched/tools/dynamo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  type AccessCaps,
  type AccessReservation,
  type AccessStore,
  createDynamoAccessStore,
} from "../src/lib/access-store";
import { dynamoLocalAvailable, localClient, tableFactory } from "./dynamo-local";

const DAY = "2026-10-20";
const available = await dynamoLocalAvailable();
const client = localClient();
const tables = tableFactory(client);

afterAll(async () => {
  if (available) await tables.dropAll();
  client.destroy();
});

const reservation = (n: number, day = DAY): AccessReservation => ({
  requestId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  username: `user-${String(n).padStart(8, "0")}`,
  day,
  accessExpiresAt: "2026-10-21T14:00:00Z",
});

describe.skipIf(!available)("createDynamoAccessStore (DynamoDB Local)", () => {
  let store: AccessStore;
  let tableName: string;
  const doc = createDocumentClient(client);

  beforeEach(async () => {
    tableName = await tables.create();
    store = createDynamoAccessStore({ tableName, doc });
  });

  const counter = async (sk: string) =>
    (await doc.send(new GetCommand({ TableName: tableName, Key: { PK: "ACCESS#COUNT", SK: sk } }))).Item;
  const registry = async () =>
    (
      await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": "ACCESS#ISSUED" },
        }),
      )
    ).Items ?? [];

  it("issues places 1..cap, then refuses the next with the daily cap, creating no registry entry", async () => {
    const caps: AccessCaps = { daily: 3, active: 100 };
    const results = [];
    for (let n = 1; n <= 4; n++) results.push(await store.reserve(reservation(n), caps));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, reason: "capped" }]);
    expect(await registry()).toHaveLength(3);
    expect((await counter(`DAY#${DAY}`))?.issued).toBe(3);
    // The refused request used no active place either.
    expect((await counter("ACTIVE"))?.active).toBe(3);
  });

  it("refuses at the active cap on any day, and the refused request uses no daily place", async () => {
    const caps: AccessCaps = { daily: 100, active: 2 };
    await store.reserve(reservation(1), caps);
    await store.reserve(reservation(2), caps);
    await expect(store.reserve(reservation(3, "2026-10-21"), caps)).resolves.toEqual({
      ok: false,
      reason: "capped",
    });
    expect(await counter("DAY#2026-10-21")).toBeUndefined();
    expect(await registry()).toHaveLength(2);
  });

  it("gives each clinic-local day its own daily counter", async () => {
    const caps: AccessCaps = { daily: 1, active: 100 };
    await expect(store.reserve(reservation(1), caps)).resolves.toEqual({ ok: true });
    await expect(store.reserve(reservation(2), caps)).resolves.toEqual({ ok: false, reason: "capped" });
    await expect(store.reserve(reservation(3, "2026-10-21"), caps)).resolves.toEqual({ ok: true });
  });

  it("lets exactly the cap through when many requests race for the last places (active cap)", async () => {
    const caps: AccessCaps = { daily: 100, active: 3 };
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => store.reserve(reservation(i + 1), caps)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    // On DynamoDB Local the losers fail their condition; on the service a loser may instead see a conflict.
    expect(
      results.filter((r) => !r.ok).every((r) => !r.ok && ["capped", "conflict"].includes(r.reason)),
    ).toBe(true);
    expect(await registry()).toHaveLength(3);
    expect((await counter("ACTIVE"))?.active).toBe(3);
  });

  it("lets exactly the cap through when many requests race for the last places (daily cap)", async () => {
    const caps: AccessCaps = { daily: 2, active: 100 };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.reserve(reservation(i + 1), caps)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(await registry()).toHaveLength(2);
    expect((await counter(`DAY#${DAY}`))?.issued).toBe(2);
  });

  it("commits the profile and the sub, and refuses to write a second profile for the same sub", async () => {
    const patient: Patient = {
      patientId: "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01",
      firstName: "Noor",
      lastName: "Vance",
      dateOfBirth: "1990-08-09",
      createdAt: "2026-10-20T14:00:00Z",
    };
    const r = reservation(1);
    await store.reserve(r, { daily: 5, active: 5 });
    await store.commit({ ...r, username: "user-bbbbbbbb" }, patient);

    const profile = await doc.send(
      new GetCommand({ TableName: tableName, Key: { PK: `PATIENT#${patient.patientId}`, SK: "PROFILE" } }),
    );
    expect(profile.Item).toMatchObject({ firstName: "Noor", lastName: "Vance", dateOfBirth: "1990-08-09" });
    expect(await registry()).toMatchObject([{ sub: patient.patientId, username: "user-bbbbbbbb" }]);

    await expect(store.commit(r, patient)).rejects.toThrow();
  });

  it("refuses to commit a profile for a reservation that doesn't exist, writing no profile", async () => {
    const patient: Patient = {
      patientId: "9d1e4b7a-2c3f-4a5b-8e6d-1f2a3b4c5d6e",
      firstName: "Noor",
      lastName: "Vance",
      dateOfBirth: "1990-08-09",
      createdAt: "2026-10-20T14:00:00Z",
    };
    await expect(store.commit(reservation(9), patient)).rejects.toThrow();
    const profile = await doc.send(
      new GetCommand({ TableName: tableName, Key: { PK: `PATIENT#${patient.patientId}`, SK: "PROFILE" } }),
    );
    expect(profile.Item).toBeUndefined();
  });
});
