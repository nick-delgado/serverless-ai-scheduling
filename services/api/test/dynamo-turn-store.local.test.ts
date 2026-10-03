/**
 * The DynamoDB TurnStore against DynamoDB Local: the daily cap's boundary, concurrent calls, and the
 * write-once trace. Skipped locally without DynamoDB Local; required in CI (see `dynamo-local.ts`).
 */
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { TurnTrace } from "@sched/contracts";
import { createDocumentClient } from "@sched/tools/dynamo";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { TurnStore } from "../src";
import { createDynamoTurnStore } from "../src/lib/dynamo-turn-store";
import { dynamoLocalAvailable, localClient, tableFactory } from "./dynamo-local";

const PATIENT = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";
const OTHER = "9d1e4b7a-2c3f-4a5b-8e6d-1f2a3b4c5d6e";
const DAY = "2026-10-05";

const available = await dynamoLocalAvailable();
const client = localClient();
const tables = tableFactory(client);

afterAll(async () => {
  if (available) await tables.dropAll();
  client.destroy();
});

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

describe.skipIf(!available)("createDynamoTurnStore (DynamoDB Local)", () => {
  let store: TurnStore;

  beforeEach(async () => {
    const tableName = await tables.create();
    store = createDynamoTurnStore({ tableName, doc: createDocumentClient(client) });
  });

  it("counts turns 1..cap, then refuses the next one", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.consumeDailyTurn(PATIENT, DAY, 3));
    expect(results).toEqual([
      { ok: true, used: 1 },
      { ok: true, used: 2 },
      { ok: true, used: 3 },
      { ok: false, used: 3 },
    ]);
    // Another patient, and the next day, have their own counters.
    expect(await store.consumeDailyTurn(OTHER, DAY, 3)).toEqual({ ok: true, used: 1 });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-06", 3)).toEqual({ ok: true, used: 1 });
  });

  it("lets exactly cap of cap + 3 concurrent calls through", async () => {
    const cap = 5;
    const results = await Promise.all(
      Array.from({ length: cap + 3 }, () => store.consumeDailyTurn(PATIENT, DAY, cap)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(cap);
    expect(
      results
        .filter((r) => r.ok)
        .map((r) => r.used)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("stores a turn's trace once and rejects a second write for the same turn", async () => {
    await store.saveTrace(PATIENT, trace);
    await expect(store.saveTrace(PATIENT, trace)).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });
});
