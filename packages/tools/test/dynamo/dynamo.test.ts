/**
 * The DynamoDB repositories against DynamoDB Local: the shared contract suite (every test on a fresh
 * table seeded with `contractSeed()`), plus storage-level checks the interface can't see (sparse GSI1
 * attributes, stored `patientId`, the fixed `ESC` key, the CONFLICT mapping).
 *
 * Caveat: DynamoDB Local updates GSIs synchronously; the real table doesn't. See the ADR-004 amendment.
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { FrozenClock } from "../../src/clock";
import { createDocumentClient, createDynamoRepositories, writeSeed } from "../../src/repos/dynamo";
import { keys } from "../../src/repos/dynamo/items";
import { sequentialIds } from "../../src/repos/ids";
import type { Repositories } from "../../src/repos/types";
import { runRepositoryContract } from "../contract/repositories.contract";
import { AISHA, APPT, CONV_A, MARIA, NOW, SLOT, WALTER, contractSeed, message } from "../contract/scenario";
import { dynamoLocalAvailable, localClient, tableFactory } from "./local";

const available = await dynamoLocalAvailable();
const client = localClient();
const tables = tableFactory(client);

afterAll(async () => {
  if (available) await tables.dropAll();
  client.destroy();
});

describe.skipIf(!available)("DynamoDB repositories (DynamoDB Local)", () => {
  runRepositoryContract("dynamodb-local", async (seed, { clock, ids }) => {
    const tableName = await tables.create();
    await writeSeed({ tableName, client, seed });
    return createDynamoRepositories({ tableName, client, clock, ids });
  });

  describe("storage details", () => {
    const doc = createDocumentClient(client);
    let tableName: string;
    let repos: Repositories;
    const raw = async (key: { PK: string; SK: string }) =>
      (await doc.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }))).Item;

    beforeEach(async () => {
      tableName = await tables.create();
      await writeSeed({ tableName, client, seed: contractSeed() });
      repos = createDynamoRepositories({
        tableName,
        client,
        clock: new FrozenClock(NOW),
        ids: sequentialIds(),
      });
    });

    it("book removes the slot's GSI1 attributes; reschedule restores them on the released slot", async () => {
      const leeTue2pm = keys.slot("prov_lee", "2026-10-13T18:00:00Z");
      expect(await raw(leeTue2pm)).toMatchObject({
        GSI1PK: "OPEN#dermatology#2026-10-13",
        GSI1SK: "2026-10-13T18:00:00Z#prov_lee",
      });
      const booked = await repos.appointments.book({
        patientId: AISHA,
        slotId: SLOT.leeTue2pm,
        reason: "Rash",
      });
      expect(booked.ok).toBe(true);
      const after = await raw(leeTue2pm);
      expect(after).not.toHaveProperty("GSI1PK");
      expect(after).not.toHaveProperty("GSI1SK");

      const mariaHeld = keys.slot("prov_lee", "2026-10-13T18:30:00Z");
      expect(await raw(mariaHeld)).not.toHaveProperty("GSI1PK");
      const moved = await repos.appointments.reschedule({
        patientId: MARIA,
        appointmentId: APPT.mariaLee,
        newSlotId: SLOT.leeTue3pm,
      });
      expect(moved.ok).toBe(true);
      const released = await raw(mariaHeld);
      expect(released).toMatchObject({
        status: "OPEN",
        GSI1PK: "OPEN#dermatology#2026-10-13",
        GSI1SK: "2026-10-13T18:30:00Z#prov_lee",
      });
      expect(released).not.toHaveProperty("appointmentId");
      expect(await raw(keys.slot("prov_lee", "2026-10-13T19:00:00Z"))).not.toHaveProperty("GSI1PK");
    });

    it("reschedule returns CONFLICT when the appointment changes between its read and its write", async () => {
      // A second client stands in for a concurrent writer: just before the reschedule transaction is
      // sent, it cancels the appointment. The appointment's condition fails and nothing changes.
      const racing = localClient();
      const rival = createDocumentClient(localClient());
      let fired = false;
      racing.middlewareStack.add(
        (next, context) => async (args) => {
          if (context.commandName === "TransactWriteItemsCommand" && !fired) {
            fired = true;
            await rival.send(
              new UpdateCommand({
                TableName: tableName,
                Key: keys.appointment(MARIA, APPT.mariaLee),
                UpdateExpression: "SET #s = :c",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":c": "CANCELLED" },
              }),
            );
          }
          return next(args);
        },
        { step: "initialize" },
      );
      const racingRepos = createDynamoRepositories({
        tableName,
        client: racing,
        clock: new FrozenClock(NOW),
        ids: sequentialIds(),
      });
      const result = await racingRepos.appointments.reschedule({
        patientId: MARIA,
        appointmentId: APPT.mariaLee,
        newSlotId: SLOT.leeTue2pm,
      });
      expect(fired).toBe(true);
      expect(result).toEqual({ ok: false, reason: "CONFLICT" });
      expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({ status: "OPEN" });
      expect(await repos.slots.get(SLOT.mariaHeld)).toMatchObject({
        status: "BOOKED",
        appointmentId: APPT.mariaLee,
      });
      racing.destroy();
      rival.destroy();
    });

    it("retries a transaction cancelled only by TransactionConflict (DynamoDB Local never produces one)", async () => {
      // The real service cancels a transaction that collides with another in-flight transaction on the
      // same item. DynamoDB Local serializes transactions instead, so inject the first two cancellations.
      const flaky = localClient();
      let injected = 0;
      flaky.middlewareStack.add(
        (next, context) => async (args) => {
          if (context.commandName === "TransactWriteItemsCommand" && injected < 2) {
            injected++;
            throw new TransactionCanceledException({
              message: "Transaction cancelled (injected)",
              $metadata: {},
              CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
            });
          }
          return next(args);
        },
        { step: "initialize" },
      );
      const flakyRepos = createDynamoRepositories({
        tableName,
        client: flaky,
        clock: new FrozenClock(NOW),
        ids: sequentialIds(),
      });
      const result = await flakyRepos.appointments.book({
        patientId: AISHA,
        slotId: SLOT.leeTue2pm,
        reason: "Rash",
      });
      expect(injected).toBe(2);
      expect(result).toMatchObject({ ok: true, alreadyBooked: false });
      expect(await repos.appointments.listForPatient(AISHA)).toHaveLength(1);
      flaky.destroy();
    });

    it("message items store the owner's patientId, opaque JSON content, and a 30-day TTL", async () => {
      await repos.conversations.append(MARIA, [message(CONV_A, 0)]);
      const item = await raw(keys.message(CONV_A, 0));
      expect(item).toMatchObject({
        PK: `CONV#${CONV_A}`,
        SK: "MSG#000000",
        patientId: MARIA,
        content: JSON.stringify(message(CONV_A, 0).content),
        expiresAt: Date.parse(NOW) / 1000 + 30 * 24 * 3600,
      });
      expect(await raw(keys.conversationMeta(MARIA, NOW, CONV_A))).toMatchObject({ conversationId: CONV_A });
    });

    it("hides a whole conversation if any item in it belongs to someone else", async () => {
      await repos.conversations.append(MARIA, [message(CONV_A, 0), message(CONV_A, 1)]);
      // A corrupted or injected item (not writable through the repository) must not leak or merge.
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...keys.message(CONV_A, 2), patientId: WALTER, content: "[]" },
        }),
      );
      expect(await repos.conversations.listMessages(MARIA, CONV_A)).toEqual([]);
      expect(await repos.conversations.listMessages(WALTER, CONV_A)).toEqual([]);
    });

    it("stores the escalation under the fixed ESC key", async () => {
      await repos.escalations.record({
        patientId: MARIA,
        conversationId: CONV_A,
        reason: "patient_requested",
        summary: "Patient asked to speak with a person about a dermatology visit.",
      });
      expect(await raw({ PK: `CONV#${CONV_A}`, SK: "ESC" })).toMatchObject({ patientId: MARIA });
    });
  });
});
