/**
 * DynamoDB repositories on the single table (ADR-004 + the 2026-09-29 amendment). Same semantics as the
 * in-memory ones; both pass `test/contract/repositories.contract.ts`.
 *
 * - Multi-item writes are one `TransactWriteItems` with condition expressions (CLAUDE.md rule 2). A failed
 *   condition is mapped to the typed business result by looking at which item's condition failed.
 * - `TransactionConflict` (another transaction touching the same item at the same moment) is retried from
 *   the top, re-reading state, a bounded number of times.
 * - Base-table reads are strongly consistent. GSI1 queries (AP-3, AP-5) can't be: on the real table a
 *   just-booked slot may appear open for a moment. Booking conditions on the base item, so that ends in
 *   SLOT_UNAVAILABLE, never a double booking.
 * - Conversation and escalation reads and writes check `patientId` (amendment): another patient's data
 *   reads exactly like missing data.
 */
import { DynamoDBClient, TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  paginateQuery,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  Appointment,
  ConversationMessage,
  Escalation,
  parseSlotId,
  PatientId,
  type AppointmentId,
  type IsoDate,
  type ProviderId,
  type Slot,
  type SlotId,
  type Specialty,
} from "@sched/contracts";

import type { Clock } from "../../clock";
import { randomIds } from "../ids";
import { compareProviders, providerMatchesName } from "../provider-match";
import { validateSeed, type ClinicSeed } from "../seed";
import {
  ConversationAppendError,
  MAX_APPEND_BATCH,
  type AppointmentRepo,
  type BookResult,
  type ConversationRepo,
  type ConversationSummary,
  type EscalationRepo,
  type IdGenerator,
  type PatientRepo,
  type ProviderRepo,
  type RecordEscalationResult,
  type Repositories,
  type RescheduleResult,
  type SlotRepo,
} from "../types";
import {
  appointmentFrom,
  appointmentItem,
  conversationMetaItem,
  escalationFrom,
  escalationItem,
  keys,
  messageFrom,
  messageItem,
  openSlotGsi1,
  patientFrom,
  patientItem,
  PROVIDERS_GSI1PK,
  providerFrom,
  providerItem,
  slotFrom,
  slotItem,
  type Item,
  type Key,
} from "./items";
import { GSI1 } from "./table";

export interface DynamoRepositoryOptions {
  /** The table, e.g. `sched-dev-main` (from SSM `/sched/<env>/data/table-name`). */
  tableName: string;
  /** Low-level client; inject one for DynamoDB Local or tests. Defaults to `new DynamoDBClient({})`. */
  client?: DynamoDBClient;
  /** Source of `createdAt`/`updatedAt`. */
  clock: Clock;
  /** Defaults to `randomIds()`. */
  ids?: IdGenerator;
}

/** How many times a transaction cancelled only by `TransactionConflict` is re-attempted. */
const MAX_ATTEMPTS = 5;
const RETRY = Symbol("retry");

const CONDITION_FAILED = "ConditionalCheckFailed";

/** Per-item cancellation codes of a cancelled transaction, or null if `err` is something else. */
function cancellationCodes(err: unknown): (string | undefined)[] | null {
  if (!(err instanceof TransactionCanceledException)) return null;
  return (err.CancellationReasons ?? []).map((r) => r.Code);
}

function isConflictOnly(codes: readonly (string | undefined)[]): boolean {
  return codes.includes("TransactionConflict") && !codes.includes(CONDITION_FAILED);
}

const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt + Math.random() * 20));

/** Run `attempt` until it returns something other than RETRY, at most MAX_ATTEMPTS times. */
async function retrying<T>(attempt: () => Promise<T | typeof RETRY>, exhausted: () => T): Promise<T> {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const result = await attempt();
    if (result !== RETRY) return result;
    await backoff(i);
  }
  return exhausted();
}

const MINUTE_MS = 60_000;
const canonicalMinute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}:00Z`;

/** Build a document client that drops undefined optional fields (e.g. `Patient.preferredProviderId`). */
export function createDocumentClient(
  client: DynamoDBClient = new DynamoDBClient({}),
): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export function createDynamoRepositories(options: DynamoRepositoryOptions): Repositories {
  const { tableName: TableName, clock } = options;
  const ids = options.ids ?? randomIds();
  const doc = createDocumentClient(options.client);
  const nowIso = (): string => clock.now().toISOString();

  async function getItem<T>(Key: Key, parse: (item: Item) => T): Promise<T | null> {
    const out = await doc.send(new GetCommand({ TableName, Key, ConsistentRead: true }));
    return out.Item ? parse(out.Item) : null;
  }

  async function queryAll(input: Omit<QueryCommandInput, "TableName">): Promise<Item[]> {
    const items: Item[] = [];
    for await (const page of paginateQuery({ client: doc }, { TableName, ...input })) {
      items.push(...(page.Items ?? []));
    }
    return items;
  }

  const transact = (TransactItems: NonNullable<TransactWriteCommandInput["TransactItems"]>) =>
    doc.send(new TransactWriteCommand({ TransactItems }));

  // -------------------------------------------------------------------------------------------
  const patients: PatientRepo = {
    get: (patientId) => getItem(keys.patient(patientId), patientFrom),
  };

  // -------------------------------------------------------------------------------------------
  const providers: ProviderRepo = {
    get: (providerId) => getItem(keys.provider(providerId), providerFrom),
    async list(filter = {}) {
      const { specialty, nameQuery } = filter;
      const items = await queryAll({
        IndexName: GSI1,
        KeyConditionExpression:
          specialty === undefined ? "GSI1PK = :pk" : "GSI1PK = :pk AND begins_with(GSI1SK, :prefix)",
        ExpressionAttributeValues: {
          ":pk": PROVIDERS_GSI1PK,
          ...(specialty === undefined ? {} : { ":prefix": `${specialty}#` }),
        },
      });
      return items
        .map(providerFrom)
        .filter((p) => nameQuery === undefined || providerMatchesName(p, nameQuery))
        .sort(compareProviders);
    },
  };

  // -------------------------------------------------------------------------------------------
  const slotKey = (slotId: SlotId): Key | null => {
    const at = parseSlotId(slotId);
    return at ? keys.slot(at.providerId, at.startUtc) : null;
  };
  const getSlot = (slotId: SlotId): Promise<Slot | null> => {
    const key = slotKey(slotId);
    return key ? getItem(key, slotFrom) : Promise.resolve(null);
  };

  const slots: SlotRepo = {
    get: getSlot,

    async listOpenByProvider(providerId: ProviderId, range) {
      const from = Date.parse(range.fromUtc);
      const to = Date.parse(range.toUtc);
      if (Number.isNaN(from) || Number.isNaN(to))
        throw new RangeError(`Invalid range ${JSON.stringify(range)}`);
      // Slots start on whole minutes, so [from, to) as instants is exactly the key range from the first
      // whole minute >= from to the last whole minute < to. Comparing instants, not the caller's strings.
      const lo = Math.ceil(from / MINUTE_MS) * MINUTE_MS;
      const hi = Math.ceil(to / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
      if (hi < lo) return [];
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :lo AND :hi",
        FilterExpression: "#status = :open",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":pk": keys.provider(providerId).PK,
          ":lo": `SLOT#${canonicalMinute(lo)}`,
          ":hi": `SLOT#${canonicalMinute(hi)}`,
          ":open": "OPEN",
        },
        ConsistentRead: true,
      });
      return items
        .map(slotFrom)
        .filter((s) => Date.parse(s.startUtc) >= from && Date.parse(s.startUtc) < to)
        .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc));
    },

    async listOpenBySpecialtyAndDay(specialty: Specialty, day: IsoDate) {
      // Sparse GSI1: only OPEN slots carry GSI1PK (eventually consistent; see the header).
      const items = await queryAll({
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": `OPEN#${specialty}#${day}` },
      });
      return items
        .map(slotFrom)
        .filter((s) => s.status === "OPEN")
        .sort(
          (a, b) =>
            Date.parse(a.startUtc) - Date.parse(b.startUtc) ||
            (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0),
        );
    },
  };

  // -------------------------------------------------------------------------------------------
  /** A BOOKED slot: is it this patient's BOOKED appointment (an idempotent retry)? */
  async function heldBy(patientId: PatientId, slot: Slot): Promise<BookResult> {
    if (slot.appointmentId) {
      const holder = await getItem(keys.appointment(patientId, slot.appointmentId), appointmentFrom);
      if (holder && holder.status === "BOOKED" && holder.slotId === slot.slotId) {
        return { ok: true, appointment: holder, alreadyBooked: true };
      }
    }
    return { ok: false, reason: "SLOT_UNAVAILABLE" };
  }

  const SLOT_NAMES = { "#status": "status", "#appt": "appointmentId" };

  const appointments: AppointmentRepo = {
    get: (patientId, appointmentId: AppointmentId) =>
      getItem(keys.appointment(patientId, appointmentId), appointmentFrom),

    async listForPatient(patientId) {
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :appt)",
        ExpressionAttributeValues: { ":pk": keys.patient(patientId).PK, ":appt": "APPT#" },
        ConsistentRead: true,
      });
      return items
        .map(appointmentFrom)
        .sort(
          (a, b) =>
            Date.parse(a.startUtc) - Date.parse(b.startUtc) ||
            (a.appointmentId < b.appointmentId ? -1 : a.appointmentId > b.appointmentId ? 1 : 0),
        );
    },

    // AP-6
    async book({ patientId, slotId, reason }) {
      PatientId.parse(patientId);
      const cleanReason = Appointment.shape.reason.parse(reason);
      const key = slotKey(slotId);
      if (!key) return { ok: false, reason: "SLOT_NOT_FOUND" };

      return retrying<BookResult>(
        async () => {
          const slot = await getItem(key, slotFrom);
          if (!slot) return { ok: false, reason: "SLOT_NOT_FOUND" };
          if (slot.status !== "OPEN") return heldBy(patientId, slot);

          const appointmentId = ids.appointmentId();
          const now = nowIso();
          const appointment = Appointment.parse({
            appointmentId,
            patientId,
            providerId: slot.providerId,
            slotId: slot.slotId,
            specialty: slot.specialty,
            startUtc: slot.startUtc,
            endUtc: slot.endUtc,
            status: "BOOKED",
            reason: cleanReason,
            createdAt: now,
            updatedAt: now,
          });
          try {
            await transact([
              {
                Update: {
                  TableName,
                  Key: key,
                  UpdateExpression: "SET #status = :booked, #appt = :id REMOVE GSI1PK, GSI1SK",
                  ConditionExpression: "#status = :open",
                  ExpressionAttributeNames: SLOT_NAMES,
                  ExpressionAttributeValues: { ":booked": "BOOKED", ":open": "OPEN", ":id": appointmentId },
                },
              },
              {
                Put: {
                  TableName,
                  Item: appointmentItem(appointment),
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
            ]);
            return { ok: true, appointment, alreadyBooked: false };
          } catch (err) {
            const codes = cancellationCodes(err);
            if (!codes) throw err;
            if (codes[1] === CONDITION_FAILED) {
              throw new Error(`IdGenerator returned a duplicate id ${appointmentId}`, { cause: err });
            }
            if (codes[0] === CONDITION_FAILED) {
              // Someone booked it first. Re-read: it may be this patient's own concurrent call.
              const current = await getItem(key, slotFrom);
              if (!current) return { ok: false, reason: "SLOT_NOT_FOUND" };
              return current.status === "OPEN" ? RETRY : heldBy(patientId, current);
            }
            if (isConflictOnly(codes)) return RETRY;
            throw err;
          }
        },
        () => {
          throw new Error(`book ${slotId}: transaction kept conflicting after ${MAX_ATTEMPTS} attempts`);
        },
      );
    },

    // AP-7
    async reschedule({ patientId, appointmentId, newSlotId }) {
      PatientId.parse(patientId);
      const apptKey = keys.appointment(patientId, appointmentId);

      return retrying<RescheduleResult>(
        async () => {
          const appt = await getItem(apptKey, appointmentFrom);
          if (!appt) return { ok: false, reason: "APPOINTMENT_NOT_FOUND" };
          if (appt.status !== "BOOKED") return { ok: false, reason: "APPOINTMENT_NOT_BOOKED" };
          if (appt.slotId === newSlotId) return { ok: true, alreadyRescheduled: true, appointment: appt };
          const newKey = slotKey(newSlotId);
          const newSlot = newKey ? await getItem(newKey, slotFrom) : null;
          if (!newKey || !newSlot) return { ok: false, reason: "SLOT_NOT_FOUND" };
          if (newSlot.status !== "OPEN") return { ok: false, reason: "SLOT_UNAVAILABLE" };
          const old = parseSlotId(appt.slotId);
          if (!old)
            throw new Error(`Invariant violated: appointment ${appointmentId} has slotId ${appt.slotId}`);

          const moved = Appointment.parse({
            ...appt,
            providerId: newSlot.providerId,
            slotId: newSlot.slotId,
            specialty: newSlot.specialty,
            startUtc: newSlot.startUtc,
            endUtc: newSlot.endUtc,
            updatedAt: nowIso(),
          });
          const reopened = openSlotGsi1(appt.specialty, old.providerId, old.startUtc);
          try {
            await transact([
              {
                // Release the old slot: back to OPEN, GSI1 restored.
                Update: {
                  TableName,
                  Key: keys.slot(old.providerId, old.startUtc),
                  UpdateExpression: "SET #status = :open, GSI1PK = :gpk, GSI1SK = :gsk REMOVE #appt",
                  ConditionExpression: "#appt = :id AND #status = :booked",
                  ExpressionAttributeNames: SLOT_NAMES,
                  ExpressionAttributeValues: {
                    ":open": "OPEN",
                    ":booked": "BOOKED",
                    ":id": appointmentId,
                    ":gpk": reopened.GSI1PK,
                    ":gsk": reopened.GSI1SK,
                  },
                },
              },
              {
                // Book the new slot: OPEN → BOOKED, GSI1 removed.
                Update: {
                  TableName,
                  Key: newKey,
                  UpdateExpression: "SET #status = :booked, #appt = :id REMOVE GSI1PK, GSI1SK",
                  ConditionExpression: "#status = :open",
                  ExpressionAttributeNames: SLOT_NAMES,
                  ExpressionAttributeValues: { ":open": "OPEN", ":booked": "BOOKED", ":id": appointmentId },
                },
              },
              {
                // Move the appointment, only if it is still BOOKED in the slot we read.
                Update: {
                  TableName,
                  Key: apptKey,
                  UpdateExpression:
                    "SET #slotId = :slotId, #providerId = :providerId, #specialty = :specialty, " +
                    "#startUtc = :startUtc, #endUtc = :endUtc, #updatedAt = :updatedAt",
                  ConditionExpression: "#status = :booked AND #slotId = :oldSlotId",
                  ExpressionAttributeNames: {
                    "#status": "status",
                    "#slotId": "slotId",
                    "#providerId": "providerId",
                    "#specialty": "specialty",
                    "#startUtc": "startUtc",
                    "#endUtc": "endUtc",
                    "#updatedAt": "updatedAt",
                  },
                  ExpressionAttributeValues: {
                    ":booked": "BOOKED",
                    ":oldSlotId": appt.slotId,
                    ":slotId": moved.slotId,
                    ":providerId": moved.providerId,
                    ":specialty": moved.specialty,
                    ":startUtc": moved.startUtc,
                    ":endUtc": moved.endUtc,
                    ":updatedAt": moved.updatedAt,
                  },
                },
              },
            ]);
            return { ok: true, alreadyRescheduled: false, appointment: moved, previous: appt };
          } catch (err) {
            const codes = cancellationCodes(err);
            if (!codes) throw err;
            // The appointment moved or changed status since we read it: the caller's view is stale.
            if (codes[2] === CONDITION_FAILED) return { ok: false, reason: "CONFLICT" };
            if (codes[1] === CONDITION_FAILED) return { ok: false, reason: "SLOT_UNAVAILABLE" };
            if (codes[0] === CONDITION_FAILED) {
              throw new Error(
                `Invariant violated: appointment ${appointmentId} does not hold slot ${appt.slotId}`,
                { cause: err },
              );
            }
            if (isConflictOnly(codes)) return RETRY;
            throw err;
          }
        },
        () => ({ ok: false, reason: "CONFLICT" }),
      );
    },
  };

  // -------------------------------------------------------------------------------------------
  const conversations: ConversationRepo = {
    // AP-8 (write)
    async append(patientId, messages) {
      PatientId.parse(patientId);
      const batch = messages.map((m) => ConversationMessage.parse(m));
      const first = batch[0];
      if (!first) throw new RangeError("append needs at least one message");
      if (batch.length > MAX_APPEND_BATCH) {
        throw new RangeError(`append takes at most ${MAX_APPEND_BATCH} messages, got ${batch.length}`);
      }
      batch.forEach((m, i) => {
        if (m.conversationId !== first.conversationId)
          throw new RangeError("append batch mixes conversations");
        if (m.seq !== first.seq + i)
          throw new RangeError(`append batch seqs must be consecutive from ${first.seq}`);
      });
      const { conversationId } = first;

      // [ConditionCheck on n-1 | Put meta], then one Put per message.
      const lead: NonNullable<TransactWriteCommandInput["TransactItems"]>[number] =
        first.seq > 0
          ? {
              ConditionCheck: {
                TableName,
                Key: keys.message(conversationId, first.seq - 1),
                ConditionExpression: "patientId = :sub",
                ExpressionAttributeValues: { ":sub": patientId },
              },
            }
          : {
              Put: {
                TableName,
                Item: conversationMetaItem(patientId, conversationId, first.createdAt),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            };
      const puts = batch.map((m) => ({
        Put: { TableName, Item: messageItem(patientId, m), ConditionExpression: "attribute_not_exists(PK)" },
      }));

      await retrying<null>(
        async () => {
          try {
            await transact([lead, ...puts]);
            return null;
          } catch (err) {
            const codes = cancellationCodes(err);
            if (!codes) throw err;
            if (first.seq > 0 && codes[0] === CONDITION_FAILED) {
              throw new ConversationAppendError("PREDECESSOR_MISSING", conversationId, first.seq);
            }
            const clash = codes.slice(1).findIndex((c) => c === CONDITION_FAILED);
            if (clash >= 0)
              throw new ConversationAppendError("SEQ_CONFLICT", conversationId, first.seq + clash);
            if (codes[0] === CONDITION_FAILED) {
              throw new ConversationAppendError("SEQ_CONFLICT", conversationId, first.seq); // meta item exists
            }
            if (isConflictOnly(codes)) return RETRY;
            throw err;
          }
        },
        () => {
          // Another write kept winning the race for these items: treat as a lost race.
          throw new ConversationAppendError("SEQ_CONFLICT", conversationId, first.seq);
        },
      );
    },

    // AP-8 (read)
    async listMessages(patientId, conversationId) {
      const items = await queryAll({
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :msg)",
        ExpressionAttributeValues: { ":pk": keys.message(conversationId, 0).PK, ":msg": "MSG#" },
        ConsistentRead: true,
      });
      // Ownership (amendment): all or nothing. Another patient's conversation reads as unknown.
      if (items.some((item) => item.patientId !== patientId)) return [];
      return items.map(messageFrom).sort((a, b) => a.seq - b.seq);
    },

    async listConversations(patientId, options = {}) {
      const { limit } = options;
      if (limit !== undefined && limit <= 0) return [];
      const input: Omit<QueryCommandInput, "TableName"> = {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :conv)",
        ExpressionAttributeValues: { ":pk": keys.patient(patientId).PK, ":conv": "CONV#" },
        ScanIndexForward: false, // newest first: SK is CONV#<createdAt>#<id>
        ConsistentRead: true,
      };
      const items =
        limit === undefined
          ? await queryAll(input)
          : ((await doc.send(new QueryCommand({ TableName, ...input, Limit: limit }))).Items ?? []);
      return items.map((item): ConversationSummary => ({
        conversationId: String(item.conversationId),
        patientId: String(item.patientId),
        createdAt: String(item.createdAt),
      }));
    },
  };

  // -------------------------------------------------------------------------------------------
  const escalations: EscalationRepo = {
    // AP-9 (amended): fixed `ESC` key, at most one per conversation.
    async record(input): Promise<RecordEscalationResult> {
      const key = keys.escalation(input.conversationId);
      const existingResult = (existing: Escalation): RecordEscalationResult =>
        existing.patientId === input.patientId
          ? { ok: true, escalation: existing, alreadyEscalated: true }
          : { ok: false, reason: "NOT_OWNER" };

      const existing = await getItem(key, escalationFrom);
      if (existing) return existingResult(existing);
      const escalation = Escalation.parse({
        escalationId: ids.escalationId(),
        conversationId: input.conversationId,
        patientId: input.patientId,
        reason: input.reason,
        summary: input.summary,
        createdAt: nowIso(),
        notification: input.notification ?? { status: "PENDING" },
      });
      try {
        await doc.send(
          new PutCommand({
            TableName,
            Item: escalationItem(escalation),
            ConditionExpression: "attribute_not_exists(PK)",
          }),
        );
        return { ok: true, escalation, alreadyEscalated: false };
      } catch (err) {
        if ((err as { name?: string }).name !== "ConditionalCheckFailedException") throw err;
        const winner = await getItem(key, escalationFrom); // a concurrent call recorded it first
        if (!winner) throw err;
        return existingResult(winner);
      }
    },

    async getForConversation(patientId, conversationId) {
      const escalation = await getItem(keys.escalation(conversationId), escalationFrom);
      return escalation && escalation.patientId === patientId ? escalation : null;
    },

    async updateNotification(patientId, conversationId, notification) {
      const clean = Escalation.shape.notification.parse(notification);
      try {
        const out = await doc.send(
          new UpdateCommand({
            TableName,
            Key: keys.escalation(conversationId),
            UpdateExpression: "SET notification = :n",
            ConditionExpression: "patientId = :sub",
            ExpressionAttributeValues: { ":n": clean, ":sub": patientId },
            ReturnValues: "ALL_NEW",
          }),
        );
        return out.Attributes ? escalationFrom(out.Attributes) : null;
      } catch (err) {
        if ((err as { name?: string }).name === "ConditionalCheckFailedException") return null;
        throw err;
      }
    },
  };

  return { patients, providers, slots, appointments, conversations, escalations };
}

/**
 * Write a validated seed (`validateSeed`) with BatchWriteItem, 25 items per call, retrying unprocessed
 * items. **Unconditional puts:** existing items with the same keys are overwritten. For fresh tables
 * (tests, DynamoDB Local) and for #14's dev seed script, which must decide how to treat existing data.
 */
export async function writeSeed(options: {
  tableName: string;
  client?: DynamoDBClient;
  seed: ClinicSeed;
}): Promise<{ itemsWritten: number }> {
  const seed = validateSeed(options.seed);
  const doc = createDocumentClient(options.client);
  const items: Item[] = [
    ...seed.patients.map(patientItem),
    ...seed.providers.map(providerItem),
    ...seed.slots.map(slotItem),
    ...seed.appointments.map(appointmentItem),
  ];
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 1; requests.length > 0; attempt++) {
      if (attempt > 8) throw new Error(`writeSeed: ${requests.length} items still unprocessed`);
      const out = await doc.send(new BatchWriteCommand({ RequestItems: { [options.tableName]: requests } }));
      requests = (out.UnprocessedItems?.[options.tableName] ?? []).flatMap((r) =>
        r.PutRequest?.Item ? [{ PutRequest: { Item: r.PutRequest.Item } }] : [],
      );
      if (requests.length > 0) await backoff(attempt);
    }
  }
  return { itemsWritten: items.length };
}
