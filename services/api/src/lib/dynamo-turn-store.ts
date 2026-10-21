/**
 * The DynamoDB `TurnStore`, on the single table (ADR-004). Three item types, all TTL'd:
 *
 * | Item | PK | SK | Attributes |
 * |---|---|---|---|
 * | Daily turn counter | `PATIENT#<sub>` | `TURNS#<yyyy-mm-dd>` (clinic-local day) | `turns`, `expiresAt` = two days after the day ends (UTC) |
 * | Env-wide daily turn counter (#356) | `ENV` | `TURNS#<yyyy-mm-dd>` (clinic-local day) | `turns`, `expiresAt` as above |
 * | Turn trace | `CONV#<convId>` | `TRACE#<turnId>` | `patientId`, `trace` (JSON string), `expiresAt` = start + 30 days |
 *
 * None of these keys collides with an existing query: patient queries use `APPT#`/`CONV#`, conversation
 * reads use `MSG#`, and the escalation is the fixed `ESC` key. `ENV` is no prefix of any `keys` partition key.
 *
 * Counting a turn is one `TransactWriteItems` with two conditional updates (patient, then env), so a
 * turn one cap refuses uses up neither count and concurrent turns can't overshoot either cap.
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { PutCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TurnTrace, type ConversationId, type PatientId } from "@sched/contracts";
import { MESSAGE_TTL_DAYS, keys } from "@sched/tools/dynamo";

import type { TurnStore } from "./turn-store";

/** The same retention as conversation messages (ADR-009). */
export const TRACE_TTL_DAYS = MESSAGE_TTL_DAYS;
/** Counters outlive their day briefly, so a clock skew around midnight can't reset a cap early. */
export const COUNTER_TTL_DAYS = 2;

const CONDITION_FAILED = "ConditionalCheckFailed";

const DAY_S = 24 * 60 * 60;

/** How many times a transaction cancelled only by `TransactionConflict` is attempted (#356, Q-7). */
const MAX_ATTEMPTS = 5;

/** A counter item's expiry: two days after the clinic-local `day` ends (UTC), epoch seconds. */
export const counterExpiresAt = (day: string): number =>
  Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + (1 + COUNTER_TTL_DAYS) * DAY_S;

const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5 * 2 ** attempt + Math.random() * 20));

/**
 * The patient and trace partition keys come from `@sched/tools/dynamo`'s `keys`, so those prefixes have one
 * definition. The env counter's `ENV` is this store's own literal: no other item has it.
 */
export const turnKeys = {
  dailyTurns: (patientId: PatientId, day: string) => ({ PK: keys.patient(patientId).PK, SK: `TURNS#${day}` }),
  /** The whole env's turns for the day (#356, ADR-004 amendment). */
  envDailyTurns: (day: string) => ({ PK: "ENV", SK: `TURNS#${day}` }),
  trace: (conversationId: ConversationId, turnId: string) => ({
    PK: keys.escalation(conversationId).PK,
    SK: `TRACE#${turnId}`,
  }),
};

export interface DynamoTurnStoreOptions {
  tableName: string;
  /** `send` is all we use, so tests can pass a fake. */
  doc: Pick<DynamoDBDocumentClient, "send">;
}

export function createDynamoTurnStore({ tableName, doc }: DynamoTurnStoreOptions): TurnStore {
  return {
    async consumeDailyTurn(patientId, day, caps) {
      const expiresAt = counterExpiresAt(day);
      const count = (key: { PK: string; SK: string }, cap: number, type: string) => ({
        Update: {
          TableName: tableName,
          Key: key,
          UpdateExpression: "ADD turns :one SET expiresAt = :exp, entityType = :type",
          ConditionExpression: "attribute_not_exists(turns) OR turns < :cap",
          ExpressionAttributeValues: { ":one": 1, ":cap": cap, ":exp": expiresAt, ":type": type },
        },
      });
      // Item order is the order the refusal is read back in: the patient's cap wins a tie (#356, A-3).
      const input = {
        TransactItems: [
          count(turnKeys.dailyTurns(patientId, day), caps.patient, "TURN_COUNTER"),
          count(turnKeys.envDailyTurns(day), caps.env, "ENV_TURN_COUNTER"),
        ],
      };
      for (let attempt = 1; ; attempt++) {
        try {
          await doc.send(new TransactWriteCommand(input));
          return { ok: true };
        } catch (error) {
          if (!(error instanceof TransactionCanceledException)) throw error;
          const codes = (error.CancellationReasons ?? []).map((r) => r.Code);
          if (codes[0] === CONDITION_FAILED) return { ok: false, refusedBy: "patient" };
          if (codes[1] === CONDITION_FAILED) return { ok: false, refusedBy: "env" };
          // Only a conflict with another writer: nothing was refused, so try again, then give up loudly.
          if (!codes.includes("TransactionConflict") || attempt >= MAX_ATTEMPTS) throw error;
          await backoff(attempt);
        }
      }
    },

    async saveTrace(patientId, trace) {
      const valid = TurnTrace.parse(trace);
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            ...turnKeys.trace(valid.conversationId, valid.turnId),
            entityType: "TURN_TRACE",
            patientId,
            turnId: valid.turnId,
            startedAt: valid.startedAt,
            outcome: valid.outcome,
            // Opaque JSON, like message content: nested tool inputs stay exactly as traced.
            trace: JSON.stringify(valid),
            expiresAt: Math.floor(Date.parse(valid.startedAt) / 1000) + TRACE_TTL_DAYS * DAY_S,
          },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    },
  };
}
