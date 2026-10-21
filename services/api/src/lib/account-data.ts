/**
 * Deletes one temporary patient's data and frees the slots it holds (#357, part 2; owner decision r1/A-4).
 *
 * What an account owns, all keyed from its `sub` (the patient ID, ADR-004):
 * - `PATIENT#<sub>`: `PROFILE`, `APPT#*`, `CONV#*` (one meta item per conversation) and `TURNS#*`;
 * - for each conversation `CONV#<id>`: `MSG#*`, `ESC` and `TRACE#*`.
 *
 * Order, so a run that stops part-way leaves what the next run needs to find the rest: first each conversation's own
 * partition, then its meta item (the only pointer to it), then the appointments, then the turn counters, and the
 * profile last. Everything is read with `ConsistentRead` and deleted with `DeleteItem`, which the permissions boundary
 * allows (it has no `BatchWriteItem`). A missing item is a delete that already happened, so every step can be repeated.
 *
 * A BOOKED appointment's slot goes back to OPEN, GSI1 keys restored (`openSlotGsi1`), in one transaction with the
 * appointment's delete, on the condition that the slot still holds this appointment. If the condition fails the slot
 * is not this appointment's any more (it was freed, or a reschedule moved the appointment): the appointment is re-read,
 * and either the new slot is released or the appointment alone is deleted. The release never creates a slot: an
 * `Update` with a condition on an attribute only a booked slot has can't succeed on a missing item. This is a copy of
 * the slot update in `reschedule` (packages/tools/src/repos/dynamo/repositories.ts), written here on the owner's
 * decision of 2026-10-21 rather than extracted from `@sched/tools`.
 *
 * An ID token issued before the delete may pass the authorizer for up to an hour, so a chat turn in that window can
 * write new `CONV#`, `MSG#` and `TURNS#` items after this ran. They carry a TTL (ADR-009). Staff emails an escalation
 * sent stay in the mailbox, and point-in-time recovery keeps deleted items restorable for 35 days.
 */
import {
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { PatientId, parseSlotId, type Specialty } from "@sched/contracts";
import { keys, openSlotGsi1 } from "@sched/tools/dynamo";

import { CONDITION_FAILED, cancellationCodes } from "./access-store";
import { queryAll } from "./query-all";

/** What a deletion did, for the job's log: counts only. */
export interface AccountDeleted {
  /** Items deleted (profile, appointments, conversations and their items, counters). */
  items: number;
  /** Slots that went back to OPEN. */
  slotsFreed: number;
}

export interface AccountData {
  deleteAccount(patientId: string): Promise<AccountDeleted>;
}

type Key = { PK: string; SK: string };

/** How many `DeleteItem` calls run at once. */
const DELETE_CONCURRENCY = 10;
/** How often an appointment is re-read after a reschedule moved it under the release's feet. */
const MAX_RELEASE_ATTEMPTS = 5;
const SLOT_NAMES = { "#status": "status", "#appt": "appointmentId" };

export function createAccountData(options: {
  tableName: string;
  /** `send` is all we use, so tests can pass a fake. */
  doc: Pick<DynamoDBDocumentClient, "send">;
}): AccountData {
  const { tableName: TableName } = options;
  const { doc } = options;

  /** Every item of a partition: its key, and the attributes the deletion reads. */
  async function partition(pk: string): Promise<Record<string, unknown>[]> {
    return queryAll(doc, {
      TableName,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ProjectionExpression: "PK, SK, conversationId",
      ExpressionAttributeValues: { ":pk": pk },
    });
  }

  const keyOf = (item: Record<string, unknown>): Key => ({ PK: String(item.PK), SK: String(item.SK) });

  async function deleteAll(toDelete: Key[]): Promise<void> {
    for (let i = 0; i < toDelete.length; i += DELETE_CONCURRENCY) {
      await Promise.all(
        toDelete
          .slice(i, i + DELETE_CONCURRENCY)
          .map((Key) => doc.send(new DeleteCommand({ TableName, Key }))),
      );
    }
  }

  /** Releases a BOOKED appointment's slot and deletes the appointment. Resolves true when a slot was freed. */
  async function releaseAndDelete(key: Key): Promise<boolean> {
    let attempted: string | undefined;
    for (let attempt = 0; attempt < MAX_RELEASE_ATTEMPTS; attempt++) {
      const { Item: appt } = await doc.send(new GetCommand({ TableName, Key: key, ConsistentRead: true }));
      if (!appt) return false;
      const slot = typeof appt.slotId === "string" ? parseSlotId(appt.slotId) : null;
      if (appt.status !== "BOOKED" || !slot || attempted === appt.slotId) {
        // Not booked, no slot to give back, or the slot didn't hold this appointment when we tried it.
        await deleteAll([key]);
        return false;
      }
      attempted = appt.slotId as string;
      const reopened = openSlotGsi1(appt.specialty as Specialty, slot.providerId, slot.startUtc);
      try {
        await doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName,
                  Key: keys.slot(slot.providerId, slot.startUtc),
                  UpdateExpression: "SET #status = :open, GSI1PK = :gpk, GSI1SK = :gsk REMOVE #appt",
                  ConditionExpression: "#appt = :id AND #status = :booked",
                  ExpressionAttributeNames: SLOT_NAMES,
                  ExpressionAttributeValues: {
                    ":open": "OPEN",
                    ":booked": "BOOKED",
                    ":id": appt.appointmentId,
                    ":gpk": reopened.GSI1PK,
                    ":gsk": reopened.GSI1SK,
                  },
                },
              },
              { Delete: { TableName, Key: key } },
            ],
          }),
        );
        return true;
      } catch (error) {
        // The slot's condition failed: read the appointment again (a reschedule may have moved it).
        if (cancellationCodes(error)?.[0] === CONDITION_FAILED) continue;
        throw error;
      }
    }
    throw new Error(`appointment ${key.SK}: its slot kept changing under the release`);
  }

  return {
    async deleteAccount(sub) {
      const patientId = PatientId.parse(sub);
      const own = await partition(keys.patient(patientId).PK);
      let conversationItems = 0;
      let slotsFreed = 0;
      const startsWith = (prefix: string) => (i: Record<string, unknown>) => String(i.SK).startsWith(prefix);

      for (const meta of own.filter(startsWith("CONV#"))) {
        if (typeof meta.conversationId === "string") {
          const conversation = await partition(`CONV#${meta.conversationId}`);
          await deleteAll(conversation.map(keyOf));
          conversationItems += conversation.length;
        }
        await deleteAll([keyOf(meta)]);
      }

      for (const appt of own.filter(startsWith("APPT#"))) {
        if (await releaseAndDelete(keyOf(appt))) slotsFreed++;
      }

      const profile = keys.patient(patientId);
      const rest = own.filter((i) => keyOf(i).SK !== profile.SK && !/^(CONV|APPT)#/.test(String(i.SK)));
      await deleteAll(rest.map(keyOf));
      await deleteAll([profile]);
      const items = conversationItems + own.length;
      return { items, slotsFreed };
    },
  };
}
