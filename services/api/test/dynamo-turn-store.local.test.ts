/**
 * The DynamoDB TurnStore against DynamoDB Local: the daily caps' boundary, concurrent calls, and the
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
const THIRD = "5a7c9e1b-3d4f-4a6b-8c2d-9e0f1a2b3c4d";
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
  promptVersion: "system.v1",
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

  const caps = (patient: number, env: number) => ({ patient, env });

  it("counts turns 1..cap, then refuses the next one, with its own counter per patient and day", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await store.consumeDailyTurn(PATIENT, DAY, caps(3, 100)));
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, refusedBy: "patient" }]);
    // Another patient, and the next day, have their own counters.
    expect(await store.consumeDailyTurn(OTHER, DAY, caps(3, 100))).toEqual({ ok: true });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-06", caps(3, 100))).toEqual({ ok: true });
  });

  it("lets exactly cap of cap + 3 concurrent calls from one patient through", async () => {
    const cap = 5;
    const results = await Promise.all(
      Array.from({ length: cap + 3 }, () => store.consumeDailyTurn(PATIENT, DAY, caps(cap, 100))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(cap);
    expect(results.filter((r) => !r.ok)).toEqual(Array(3).fill({ ok: false, refusedBy: "patient" }));
  });

  it("counts the env's turns across patients, then refuses with the env's cap, leaving the patient's count alone", async () => {
    expect(await store.consumeDailyTurn(PATIENT, DAY, caps(5, 2))).toEqual({ ok: true });
    expect(await store.consumeDailyTurn(OTHER, DAY, caps(5, 2))).toEqual({ ok: true });
    expect(await store.consumeDailyTurn(THIRD, DAY, caps(5, 2))).toEqual({ ok: false, refusedBy: "env" });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-06", caps(5, 2))).toEqual({ ok: true });
    // The refused patient used nothing: with room in the env, a cap of 1 still lets their first turn in.
    expect(await store.consumeDailyTurn(THIRD, DAY, caps(1, 3))).toEqual({ ok: true });
    expect(await store.consumeDailyTurn(THIRD, DAY, caps(1, 3))).toEqual({ ok: false, refusedBy: "patient" });
  });

  it("with the env at N-1 of N, two patients at once: exactly one counts, the other gets the env refusal and keeps their own count (#356)", async () => {
    const N = 4;
    for (let i = 0; i < N - 1; i++) {
      expect(await store.consumeDailyTurn(`filler-${i}` as never, DAY, caps(5, N))).toEqual({ ok: true });
    }
    const results = await Promise.all([
      store.consumeDailyTurn(PATIENT, DAY, caps(1, N)),
      store.consumeDailyTurn(OTHER, DAY, caps(1, N)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, refusedBy: "env" }]);
    // The refused patient's own counter is unchanged: a cap of 1 admits them with env room.
    const refused = results[0]?.ok ? OTHER : PATIENT;
    expect(await store.consumeDailyTurn(refused, DAY, caps(1, N + 1))).toEqual({ ok: true });
  });

  it("counts every one of 5 patients' simultaneous turns when the env has room, whether or not DynamoDB reports a conflict", async () => {
    const patients = [PATIENT, OTHER, THIRD, "pat-d", "pat-e"] as never[];
    const results = await Promise.all(patients.map((p) => store.consumeDailyTurn(p, DAY, caps(5, 100))));
    expect(results).toEqual(Array(5).fill({ ok: true }));
  });

  it("stores a turn's trace once and rejects a second write for the same turn", async () => {
    await store.saveTrace(PATIENT, trace);
    await expect(store.saveTrace(PATIENT, trace)).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });
});
