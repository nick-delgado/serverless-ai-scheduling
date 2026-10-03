/** The in-memory TurnStore (tests and the eval harness): the cap, and the write-once, validated trace. */
import type { TurnTrace } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { createInMemoryTurnStore } from "../src";

const PATIENT = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";

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

describe("createInMemoryTurnStore", () => {
  it("counts turns up to the cap, then refuses without counting", async () => {
    const store = createInMemoryTurnStore();
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", 2)).toEqual({ ok: true, used: 1 });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", 2)).toEqual({ ok: true, used: 2 });
    expect(await store.consumeDailyTurn(PATIENT, "2026-10-05", 2)).toEqual({ ok: false, used: 2 });
    expect(store.turnsUsed(PATIENT, "2026-10-05")).toBe(2);
  });

  it("stores a trace once and rejects a second one for the same turn", async () => {
    const store = createInMemoryTurnStore();
    await store.saveTrace(PATIENT, trace);
    await expect(store.saveTrace(PATIENT, trace)).rejects.toThrow(/already stored/);
    expect(store.traces).toHaveLength(1);
  });

  it("rejects a trace that breaks the contract, and stores nothing", async () => {
    const store = createInMemoryTurnStore();
    await expect(store.saveTrace(PATIENT, { ...trace, turnId: "not-a-uuid" })).rejects.toThrow();
    expect(store.traces).toHaveLength(0);
  });
});
