/**
 * The DynamoDB TurnStore's requests, against a fake `send`. What those requests do in DynamoDB (the cap's
 * boundary, concurrent calls, the write-once trace) is checked against DynamoDB Local in
 * `dynamo-turn-store.local.test.ts`.
 */
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { TurnTrace } from "@sched/contracts";
import { describe, expect, it, vi } from "vitest";

import { createDynamoTurnStore, turnKeys } from "../src/lib/dynamo-turn-store";
import { cancelled, fakeDoc } from "./dynamo-fakes";

const PATIENT = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";

const trace: TurnTrace = {
  turnId: "00000000-0000-4000-8000-000000000002",
  conversationId: "00000000-0000-4000-8000-000000000001",
  modelProfile: "sonnet-4.6",
  modelId: "us.anthropic.claude-sonnet-4-6",
  promptVersion: "system.v1",
  startedAt: "2026-10-05T13:00:00.000Z",
  durationMs: 10,
  iterations: 1,
  llmCalls: [],
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outcome: "completed",
};

describe("createDynamoTurnStore", () => {
  const caps = { patient: 50, env: 200 };
  /** Fails with each of `failures` in turn, then succeeds. */
  const failing = (...failures: Error[]) => {
    let n = 0;
    return fakeDoc(() => {
      const failure = failures[n++];
      if (failure) throw failure;
      return {};
    });
  };

  it("counts a turn in one transaction: a conditional ADD on the patient's day item, then on the env's", async () => {
    const { doc, sent } = fakeDoc();
    const store = createDynamoTurnStore({ tableName: "t", doc });

    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const command = sent[0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    // Two days after the day ends, for both items.
    const exp = Date.parse("2026-10-08T00:00:00Z") / 1000;
    const update = (key: object, cap: number, type: string) => ({
      Update: {
        TableName: "t",
        Key: key,
        UpdateExpression: "ADD turns :one SET expiresAt = :exp, entityType = :type",
        ConditionExpression: "attribute_not_exists(turns) OR turns < :cap",
        ExpressionAttributeValues: { ":one": 1, ":cap": cap, ":exp": exp, ":type": type },
      },
    });
    expect(command.input.TransactItems).toEqual([
      update({ PK: `PATIENT#${PATIENT}`, SK: "TURNS#2026-10-05" }, 50, "TURN_COUNTER"),
      update({ PK: "ENV", SK: "TURNS#2026-10-05" }, 200, "ENV_TURN_COUNTER"),
    ]);
    expect(turnKeys.envDailyTurns("2026-10-05")).toEqual({ PK: "ENV", SK: "TURNS#2026-10-05" });
  });

  it.each([
    ["the patient's cap", ["ConditionalCheckFailed", "None"], "patient"],
    ["the env's cap", ["None", "ConditionalCheckFailed"], "env"],
    [
      "the patient's cap first when both refuse",
      ["ConditionalCheckFailed", "ConditionalCheckFailed"],
      "patient",
    ],
    [
      "the env's cap even when the patient's item only conflicted",
      ["TransactionConflict", "ConditionalCheckFailed"],
      "env",
    ],
  ] as const)("refuses on %s, without retrying", async (_name, codes, refusedBy) => {
    const { doc, sent } = failing(cancelled(...codes));
    const store = createDynamoTurnStore({ tableName: "t", doc });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).toEqual({ ok: false, refusedBy });
    expect(sent).toHaveLength(1);
  });

  it("tries again when only a conflict cancelled the transaction, and counts the turn", async () => {
    const { doc, sent } = failing(
      cancelled("TransactionConflict", "None"),
      cancelled("None", "TransactionConflict"),
    );
    const store = createDynamoTurnStore({ tableName: "t", doc });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).toEqual({ ok: true });
    expect(sent).toHaveLength(3);
  });

  it("rethrows after 5 attempts that all conflicted", async () => {
    const conflict = cancelled("TransactionConflict", "None");
    const { doc, sent } = failing(conflict, conflict, conflict, conflict, conflict, conflict);
    const store = createDynamoTurnStore({ tableName: "t", doc });
    await expect(store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).rejects.toBe(conflict);
    expect(sent).toHaveLength(5);
  });

  it("waits 10, 20, 40 then 80 ms plus up to 20 ms of jitter between conflicting attempts", async () => {
    const delays: unknown[] = [];
    const wait = vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms?: number) => {
      delays.push(ms);
      run();
      return 0;
    }) as never);
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const conflict = cancelled("TransactionConflict", "None");
      const { doc } = failing(conflict, conflict, conflict, conflict, conflict);
      const store = createDynamoTurnStore({ tableName: "t", doc });
      await expect(store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).rejects.toBe(conflict);
    } finally {
      wait.mockRestore();
      random.mockRestore();
    }
    expect(delays).toEqual([20, 30, 50, 90]);
  });

  it("rethrows a cancellation that is neither a refusal nor a conflict, without retrying", async () => {
    const other = cancelled("ValidationError", "None");
    const { doc, sent } = failing(other, other);
    const store = createDynamoTurnStore({ tableName: "t", doc });
    await expect(store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).rejects.toBe(other);
    expect(sent).toHaveLength(1);
  });

  it("rethrows a cancellation that names no reasons, without retrying", async () => {
    const bare = cancelled();
    delete (bare as { CancellationReasons?: unknown }).CancellationReasons;
    const { doc, sent } = failing(bare, bare);
    const store = createDynamoTurnStore({ tableName: "t", doc });
    await expect(store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).rejects.toBe(bare);
    expect(sent).toHaveLength(1);
  });

  it("rethrows other errors", async () => {
    const { doc } = fakeDoc(() => {
      throw new Error("network");
    });
    const store = createDynamoTurnStore({ tableName: "t", doc });
    await expect(store.consumeDailyTurn(PATIENT, "2026-10-05", caps)).rejects.toThrow("network");
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
