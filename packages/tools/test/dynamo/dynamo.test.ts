/**
 * The DynamoDB repositories against DynamoDB Local: the shared contract suite (every test on a fresh
 * table seeded with `contractSeed()`), plus storage-level checks the interface can't see (sparse GSI1
 * attributes, stored `patientId`, the fixed `ESC` key, the CONFLICT mapping).
 *
 * Caveat: DynamoDB Local updates GSIs synchronously; the real table doesn't. See the ADR-004 amendment.
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SlotId } from "@sched/contracts";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { FrozenClock } from "../../src/clock";
import { createDocumentClient, createDynamoRepositories, writeSeed } from "../../src/repos/dynamo";
import { keys } from "../../src/repos/dynamo/items";
import { sequentialIds } from "../../src/repos/ids";
import type { RescheduleResult, Repositories } from "../../src/repos/types";
import { runRepositoryContract } from "../contract/repositories.contract";
import { AISHA, APPT, CONV_A, MARIA, NOW, SLOT, WALTER, contractSeed, message } from "../contract/scenario";
import { dynamoLocalAvailable, localClient, tableFactory } from "./local";

/** The sort key a `GetItem` reads, or null for any other command (input as sent: plain or marshalled). */
function getItemSortKey(commandName: string | undefined, input: unknown): string | null {
  if (commandName !== "GetItemCommand") return null;
  const sk = (input as { Key?: { SK?: string | { S?: string } } }).Key?.SK;
  return (typeof sk === "string" ? sk : sk?.S) ?? null;
}

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

    /** The racing repositories' clock, later than `repos`' so their writes are told apart (`updatedAt`). */
    const LATER = "2026-10-05T13:05:00.000Z";

    /**
     * Repositories on a second client whose first `TransactWriteItems` (or, with `on: "slotRead"`, first
     * `GetItem` of a slot) runs `rival` just before it is sent, standing in for a concurrent writer that
     * commits between this call's reads or before its write. `rival` writes through the test's own `repos`
     * or `doc`, whose client has no middleware. `codes` records the cancellation codes if that transaction
     * is cancelled; `reads` records the sort key of every `GetItem` the racing client sends.
     */
    function withRival(rival: () => Promise<unknown>, on: "transact" | "slotRead" = "transact") {
      const racing = localClient();
      const state: { fired: boolean; codes: (string | undefined)[] | null; reads: string[] } = {
        fired: false,
        codes: null,
        reads: [],
      };
      racing.middlewareStack.add(
        (next, context) => async (args) => {
          const sk = getItemSortKey(context.commandName, args.input);
          if (sk !== null) state.reads.push(sk);
          const trigger =
            on === "transact" ? context.commandName === "TransactWriteItemsCommand" : sk?.startsWith("SLOT#");
          if (!trigger || state.fired) return next(args);
          state.fired = true;
          await rival();
          try {
            return await next(args);
          } catch (err) {
            if (err instanceof TransactionCanceledException) {
              state.codes = (err.CancellationReasons ?? []).map((r) => r.Code);
            }
            throw err;
          }
        },
        { step: "initialize" },
      );
      const racingRepos = createDynamoRepositories({
        tableName,
        client: racing,
        clock: new FrozenClock(LATER),
        ids: sequentialIds(),
      });
      return { repos: racingRepos, state, destroy: () => racing.destroy() };
    }

    const moveMariaTo = (r: Repositories, newSlotId: SlotId) =>
      r.appointments.reschedule({ patientId: MARIA, appointmentId: APPT.mariaLee, newSlotId });

    const cancelMaria = () =>
      doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: keys.appointment(MARIA, APPT.mariaLee),
          UpdateExpression: "SET #s = :c",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":c": "CANCELLED" },
        }),
      );

    /**
     * `result` is the retry answer carrying the appointment as stored after the rival's move into
     * `SLOT.leeTue2pm` (not this call's own unwritten version, which has the later `updatedAt`), and the
     * old slot is OPEN while the new one is BOOKED by the appointment.
     */
    async function expectRetryOfStoredMove(result: RescheduleResult) {
      const stored = await repos.appointments.get(MARIA, APPT.mariaLee);
      expect(stored).toMatchObject({ status: "BOOKED", slotId: SLOT.leeTue2pm, updatedAt: NOW });
      expect(result).toEqual({ ok: true, alreadyRescheduled: true, appointment: stored });
      expect(await repos.slots.get(SLOT.mariaHeld)).toMatchObject({ status: "OPEN" });
      expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({
        status: "BOOKED",
        appointmentId: APPT.mariaLee,
      });
    }

    /** Move Maria's appointment into `SLOT.leeTue2pm` with `rival` racing it, and expect CONFLICT. */
    async function expectConflictAgainst(rival: () => Promise<unknown>) {
      const racing = withRival(rival);
      const result = await moveMariaTo(racing.repos, SLOT.leeTue2pm);
      racing.destroy();
      expect(racing.state.fired).toBe(true);
      expect(result).toEqual({ ok: false, reason: "CONFLICT" });
    }

    it("reschedule returns CONFLICT when the appointment is cancelled between its read and its write", async () => {
      // Just before the reschedule transaction is sent, a concurrent writer cancels the appointment.
      // The appointment's condition fails and nothing changes.
      await expectConflictAgainst(cancelMaria);
      expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({ status: "OPEN" });
      expect(await repos.slots.get(SLOT.mariaHeld)).toMatchObject({
        status: "BOOKED",
        appointmentId: APPT.mariaLee,
      });
    });

    it("a reschedule that loses the race to an identical move answers the retry, not CONFLICT (#207)", async () => {
      // The rival makes the same move after this call read the appointment, so this call's transaction
      // fails all three conditions. The re-read finds the appointment BOOKED in newSlotId.
      let rivalResult: RescheduleResult | undefined;
      const racing = withRival(async () => {
        rivalResult = await moveMariaTo(repos, SLOT.leeTue2pm);
      });
      const result = await moveMariaTo(racing.repos, SLOT.leeTue2pm);
      // On DynamoDB Local all three conditions fail, so the appointment's code is the one inspected.
      const failed = "ConditionalCheckFailed";
      expect(racing.state.codes).toEqual([failed, failed, failed]);
      expect(rivalResult).toMatchObject({ ok: true, alreadyRescheduled: false });
      await expectRetryOfStoredMove(result);
      racing.destroy();
    });

    it("a reschedule that reads the new slot after an identical move committed answers the retry (#207)", async () => {
      // The rival makes the same move after this call read the appointment but before it reads the new
      // slot, so the slot is BOOKED by this appointment. The re-read finds it BOOKED in newSlotId.
      const racing = withRival(() => moveMariaTo(repos, SLOT.leeTue2pm), "slotRead");
      const result = await moveMariaTo(racing.repos, SLOT.leeTue2pm);
      racing.destroy();
      expect(racing.state.fired).toBe(true);
      await expectRetryOfStoredMove(result);
    });

    /** `SLOT.leeTue2pm`'s sort key, as `withRival` records it. */
    const LEE_TUE_2PM_SK = "SLOT#2026-10-13T18:00:00Z";

    /**
     * Move Maria's appointment into `SLOT.leeTue2pm` with `rival` running on the call's read of that slot,
     * and expect SLOT_UNAVAILABLE after exactly the `GetItem` reads `reads` (sort keys, in order).
     */
    async function expectSlotUnavailableOnSlotRead(rival: () => Promise<unknown>, reads: string[]) {
      const racing = withRival(rival, "slotRead");
      const result = await moveMariaTo(racing.repos, SLOT.leeTue2pm);
      racing.destroy();
      expect(result).toEqual({ ok: false, reason: "SLOT_UNAVAILABLE" });
      expect(racing.state.reads).toEqual(reads);
    }

    it("a reschedule that reads the new slot after an identical move that was then cancelled answers SLOT_UNAVAILABLE (#207)", async () => {
      // The slot is held by this appointment, so the appointment is re-read, but it is CANCELLED, not BOOKED
      // in newSlotId, so the answer isn't the retry. Reads: the appointment, the slot, the appointment again.
      await expectSlotUnavailableOnSlotRead(async () => {
        await moveMariaTo(repos, SLOT.leeTue2pm);
        await cancelMaria();
      }, [`APPT#${APPT.mariaLee}`, LEE_TUE_2PM_SK, `APPT#${APPT.mariaLee}`]);
    });

    it("a reschedule that reads the new slot after another appointment took it answers SLOT_UNAVAILABLE without a re-read", async () => {
      // One read of the appointment, one of the slot: a slot held by another appointment isn't re-checked.
      await expectSlotUnavailableOnSlotRead(
        () => repos.appointments.book({ patientId: AISHA, slotId: SLOT.leeTue2pm, reason: "Rash" }),
        [`APPT#${APPT.mariaLee}`, LEE_TUE_2PM_SK],
      );
      expect(await repos.appointments.get(MARIA, APPT.mariaLee)).toMatchObject({ slotId: SLOT.mariaHeld });
    });

    it("reschedule returns CONFLICT when a concurrent move took the appointment to another slot", async () => {
      await expectConflictAgainst(() => moveMariaTo(repos, SLOT.leeTue3pm));
      expect(await repos.appointments.get(MARIA, APPT.mariaLee)).toMatchObject({
        status: "BOOKED",
        slotId: SLOT.leeTue3pm,
      });
      expect(await repos.slots.get(SLOT.leeTue2pm)).toMatchObject({ status: "OPEN" });
    });

    it("reschedule returns CONFLICT when a concurrent move into newSlotId was then cancelled", async () => {
      // A raw cancel leaves the slot booked, so this test makes no consistency assertion.
      await expectConflictAgainst(async () => {
        await moveMariaTo(repos, SLOT.leeTue2pm);
        await cancelMaria();
      });
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

    it("stores a patient message's clientMessageId and reads it back; other messages have no such attribute", async () => {
      const clientMessageId = "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c";
      await repos.conversations.append(MARIA, [
        { ...message(CONV_A, 0), clientMessageId },
        message(CONV_A, 1),
      ]);
      expect(await raw(keys.message(CONV_A, 0))).toMatchObject({ clientMessageId });
      expect(await raw(keys.message(CONV_A, 1))).not.toHaveProperty("clientMessageId");
      const stored = await repos.conversations.listMessages(MARIA, CONV_A);
      expect(stored[0]?.clientMessageId).toBe(clientMessageId);
      expect(stored[1]).not.toHaveProperty("clientMessageId");
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
