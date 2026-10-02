/**
 * The DynamoDB `TurnStore`, on the single table (ADR-004). Two item types, both TTL'd:
 *
 * | Item | PK | SK | Attributes |
 * |---|---|---|---|
 * | Daily turn counter | `PATIENT#<sub>` | `TURNS#<yyyy-mm-dd>` (clinic-local day) | `turns`, `expiresAt` = day + 2 days |
 * | Turn trace | `CONV#<convId>` | `TRACE#<turnId>` | `patientId`, `trace` (JSON string), `expiresAt` = start + 30 days |
 *
 * Neither prefix collides with an existing query: patient queries use `APPT#`/`CONV#`, conversation
 * reads use `MSG#`, and the escalation is the fixed `ESC` key.
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TurnTrace } from "@sched/contracts";

import type { TurnStore } from "./turn-store";

/** The same retention as conversation messages (ADR-009). */
export const TRACE_TTL_DAYS = 30;
/** Counters outlive their day briefly, so a clock skew around midnight can't reset a cap early. */
export const COUNTER_TTL_DAYS = 2;

const DAY_S = 24 * 60 * 60;

export const turnKeys = {
  dailyTurns: (patientId: string, day: string) => ({ PK: `PATIENT#${patientId}`, SK: `TURNS#${day}` }),
  trace: (conversationId: string, turnId: string) => ({
    PK: `CONV#${conversationId}`,
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
    async consumeDailyTurn(patientId, day, cap) {
      const expiresAt = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + (1 + COUNTER_TTL_DAYS) * DAY_S;
      try {
        const out = await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: turnKeys.dailyTurns(patientId, day),
            UpdateExpression: "ADD turns :one SET expiresAt = :exp, entityType = :type",
            ConditionExpression: "attribute_not_exists(turns) OR turns < :cap",
            ExpressionAttributeValues: { ":one": 1, ":cap": cap, ":exp": expiresAt, ":type": "TURN_COUNTER" },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        return { ok: true, used: Number(out.Attributes?.turns ?? 1) };
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) return { ok: false, used: cap };
        throw error;
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
