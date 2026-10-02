/**
 * The DynamoDB TurnStore's requests, against a fake `send`. The conditional counter is what makes the cap
 * race-free; the live check is the deployed smoke test.
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { TurnTrace } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { createDynamoTurnStore, turnKeys } from "../src/lib/dynamo-turn-store";

const PATIENT = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";

function fakeDoc(respond: (command: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  return {
    sent,
    doc: {
      send: (command: unknown) => {
        sent.push(command);
        try {
          return Promise.resolve(respond(command));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    } as never,
  };
}

const trace: TurnTrace = {
  turnId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000001",
  modelProfile: "sonnet-4.6",
  modelId: "us.anthropic.claude-sonnet-4-6",
  promptVersion: "api-placeholder.v0",
  startedAt: "2026-10-05T13:00:00.000Z",
  durationMs: 10,
  iterations: 1,
  llmCalls: [],
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outcome: "completed",
};

describe("createDynamoTurnStore", () => {
  it("counts a turn with a conditional ADD on the patient's day item", async () => {
    const { doc, sent } = fakeDoc(() => ({ Attributes: { turns: 3 } }));
    const store = createDynamoTurnStore({ tableName: "t", doc });

    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", 50)).toEqual({ ok: true, used: 3 });
    const command = sent[0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input).toMatchObject({
      TableName: "t",
      Key: turnKeys.dailyTurns(PATIENT, "2026-10-05"),
      ConditionExpression: "attribute_not_exists(turns) OR turns < :cap",
      ExpressionAttributeValues: { ":one": 1, ":cap": 50 },
    });
    expect(command.input.Key).toEqual({ PK: `PATIENT#${PATIENT}`, SK: "TURNS#2026-10-05" });
    // Expires two days after the day ends.
    expect(command.input.ExpressionAttributeValues?.[":exp"]).toBe(Date.parse("2026-10-08T00:00:00Z") / 1000);
  });

  it("refuses when the condition fails", async () => {
    const { doc } = fakeDoc(() => {
      throw new ConditionalCheckFailedException({ message: "no", $metadata: {} });
    });
    const store = createDynamoTurnStore({ tableName: "t", doc });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", 50)).toEqual({ ok: false, used: 50 });
  });

  it("rethrows other errors", async () => {
    const { doc } = fakeDoc(() => {
      throw new Error("network");
    });
    const store = createDynamoTurnStore({ tableName: "t", doc });
    await expect(store.consumeDailyTurn(PATIENT, "2026-10-05", 50)).rejects.toThrow("network");
  });

  it("writes the trace once, under the conversation, with the owner and a 30-day TTL", async () => {
    const { doc, sent } = fakeDoc();
    await createDynamoTurnStore({ tableName: "t", doc }).saveTrace(PATIENT, trace);
    const command = sent[0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(command.input.Item).toMatchObject({
      PK: `CONV#${trace.conversationId}`,
      SK: `TRACE#${trace.turnId}`,
      patientId: PATIENT,
      expiresAt: Date.parse("2026-11-04T13:00:00Z") / 1000,
    });
    expect(JSON.parse(command.input.Item?.trace as string)).toEqual(trace);
  });
});
