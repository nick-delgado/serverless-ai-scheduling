/**
 * The chat function's metrics (`lib/observability/metrics.ts`, #38): Powertools Metrics writes raw stdout
 * EMF lines under `Env` only (A-4), and the `"chat turn"` entry becomes the turn's metrics (owner decisions
 * r1/Q-2 (a), Q-3 (a)), checked through `handleChatTurn` itself, so renaming the entry or a field it reads
 * fails here.
 */
import {
  ScriptedLlmClient,
  buildSystemPrompt,
  resolveModelProfile,
  scriptedText,
  scriptedToolUse,
  type ScriptedStep,
} from "@sched/agent";
import { FrozenClock, createInMemoryRepositories } from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryTurnStore, handleChatTurn, memorySink, type LogEntry } from "../src";
import {
  conflictRetryCounter,
  envMetrics,
  turnFigures,
  withTurnMetrics,
} from "../src/lib/observability/metrics";

type Record = {
  _aws: { CloudWatchMetrics: { Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] };
} & { [key: string]: unknown };

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

/** Every EMF record written to stdout, parsed. */
const records = (): Record[] => lines.filter((l) => l.includes('"_aws"')).map((l) => JSON.parse(l) as Record);
const dimensionsOf = (r: Record | undefined) => r?._aws.CloudWatchMetrics[0]?.Dimensions;

describe("envMetrics (A-4: raw stdout lines CloudWatch reads as EMF)", () => {
  it("writes one record as one raw stdout line under the Env dimension only, never through console", () => {
    const log = vi.spyOn(console, "log");
    const info = vi.spyOn(console, "info");
    const metrics = envMetrics("dev");
    metrics.addMetric("Turns", "Count", 1);
    metrics.publishStoredMetrics();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\{"_aws":.*\}\n$/);
    const [record] = records();
    expect(dimensionsOf(record)).toEqual([["Env"]]);
    expect(record).toMatchObject({ Env: "dev", Turns: 1 });
    expect(record).not.toHaveProperty("service");
    expect(record?._aws.CloudWatchMetrics[0]).toMatchObject({ Namespace: "Sched" });
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];

/** Runs turns through the real `handleChatTurn` with the metrics decorator; `flush` publishes the store. */
function chat(steps: ScriptedStep[], cap = 50) {
  const clock = new FrozenClock("2026-10-05T13:00:00Z");
  const entries: LogEntry[] = [];
  const turn = envMetrics("test-env");
  const coded = envMetrics("test-env");
  let tick = 0;
  let n = 0;
  const deps = {
    repos: createInMemoryRepositories({ clock, seed: buildClinicFixture() }),
    turns: createInMemoryTurnStore(),
    llm: new ScriptedLlmClient(steps),
    profile: resolveModelProfile("sonnet-4.6"),
    clock,
    systemPrompt: buildSystemPrompt,
    dailyTurnCap: cap,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    // Each reading is 100 ms after the last, so every timing is a distinct, non-zero number.
    monotonicNow: () => (tick += 100),
    log: withTurnMetrics((entry) => entries.push(entry), { turn, coded }),
  };
  return {
    entries,
    async send(clientMessageId = "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c", conversationId?: unknown) {
      const body = JSON.stringify({ clientMessageId, text: "Hello", conversationId });
      await handleChatTurn({ body, patientId: MARIA, requestId: "req-1" }, deps, memorySink().sink);
      turn.publishStoredMetrics();
      return entries.findLast((e) => e.msg === "chat turn") ?? { msg: "none" };
    },
  };
}

describe("withTurnMetrics through handleChatTurn (owner decision r1/Q-2 (a))", () => {
  it("writes a done turn's figures under Env, with its IDs as properties, and passes the entry on", async () => {
    const c = chat([
      scriptedToolUse([{ id: "tu_1", name: "find_providers", input: { name_query: "Lee" } }]),
      scriptedText("Dr. Lee is in.", { usage: { cacheReadTokens: 7, cacheWriteTokens: 3 } }),
    ]);
    const entry = await c.send();

    expect(entry).toMatchObject({ terminal: "done", replayed: false });
    expect(records()).toHaveLength(1);
    const [record] = records();
    expect(dimensionsOf(record)).toEqual([["Env"]]);
    expect(record).toMatchObject({
      Env: "test-env",
      Turns: 1,
      TurnErrors: 0,
      TimeToFirstTextMs: entry.firstTextMs,
      TurnLatencyMs: entry.totalMs,
      InputTokens: 200,
      OutputTokens: 40,
      CacheReadTokens: 7,
      CacheWriteTokens: 3,
      ToolCalls: 1,
      ToolErrors: 0,
      requestId: "req-1",
      conversationId: entry.conversationId,
      turnId: entry.turnId,
    });
    expect(typeof record?.TimeToFirstTextMs).toBe("number");
    expect(typeof record?.TurnLatencyMs).toBe("number");
    const units = Object.fromEntries(
      (record?._aws.CloudWatchMetrics[0]?.Metrics ?? []).map((m) => [m.Name, m.Unit]),
    );
    expect(units).toMatchObject({
      TimeToFirstTextMs: "Milliseconds",
      TurnLatencyMs: "Milliseconds",
      Turns: "Count",
    });
    expect(new Set(Object.values(units))).toEqual(new Set(["Milliseconds", "Count"]));
  });

  it("counts a replayed turn in Turns only", async () => {
    const c = chat([scriptedText("Hi!")]);
    const first = await c.send();
    lines.length = 0;
    const entry = await c.send(undefined, first.conversationId);

    expect(entry.replayed).toBe(true);
    const [record] = records();
    expect(record).toMatchObject({ Turns: 1 });
    for (const name of ["TurnErrors", "TimeToFirstTextMs", "TurnLatencyMs", "InputTokens", "ToolCalls"]) {
      expect(record).not.toHaveProperty(name);
    }
  });

  it("counts a turn refused before any model call in Turns and TurnErrors, also by its error code", async () => {
    const c = chat([scriptedText("Hi!")], 1);
    await c.send();
    lines.length = 0;
    const entry = await c.send("0b6f3f0e-8a51-4c3e-9d0a-2f6a3c1d9e47");

    expect(entry).toMatchObject({ terminal: "error", errorCode: "RATE_LIMITED" });
    const [coded, turn] = records();
    expect(dimensionsOf(coded)).toEqual([["Env", "ErrorCode"]]);
    expect(coded).toMatchObject({
      Env: "test-env",
      ErrorCode: "RATE_LIMITED",
      TurnErrors: 1,
      requestId: "req-1",
    });
    expect(turn).toMatchObject({ Turns: 1, TurnErrors: 1 });
    for (const name of ["TimeToFirstTextMs", "TurnLatencyMs", "InputTokens", "ToolCalls", "ToolErrors"]) {
      expect(turn).not.toHaveProperty(name);
    }
  });

  it("counts failed tool calls by code, an invented tool under NOT_FOUND", async () => {
    const c = chat([
      scriptedToolUse([
        { id: "tu_1", name: "no_such_tool", input: {} },
        { id: "tu_2", name: "find_providers", input: { name_query: "Lee" } },
      ]),
      scriptedText("Done."),
    ]);
    await c.send();

    const [coded, turn] = records();
    expect(coded).toMatchObject({ ErrorCode: "NOT_FOUND", ToolErrors: 1 });
    expect(dimensionsOf(coded)).toEqual([["Env", "ErrorCode"]]);
    expect(turn).toMatchObject({ ToolCalls: 2, ToolErrors: 1 });
  });

  it("passes other entries on unchanged and writes no metric for them", () => {
    const entries: LogEntry[] = [];
    const turn = envMetrics("e");
    const log = withTurnMetrics((e) => entries.push(e), { turn, coded: envMetrics("e") });
    const entry = { msg: "session", requestId: "r" };
    log(entry);
    expect(entries).toEqual([entry]);
    expect(turn.hasStoredMetrics()).toBe(false);
  });

  it("logs a warning naming the missing fields, and writes nothing, for a chat turn entry it can't read", () => {
    const entries: LogEntry[] = [];
    const turn = envMetrics("e");
    const log = withTurnMetrics((e) => entries.push(e), { turn, coded: envMetrics("e") });
    log({ msg: "chat turn", replayed: "no", terminal: "ended", totalMs: "5" });
    expect(entries[1]).toEqual({
      msg: "turn metrics skipped",
      level: "warn",
      missing: ["replayed", "terminal", "totalMs"],
    });
    expect(turn.hasStoredMetrics()).toBe(false);
    expect(records()).toEqual([]);

    // One missing field is enough.
    log({ msg: "chat turn", replayed: false, terminal: "done" });
    expect(entries[3]).toMatchObject({ msg: "turn metrics skipped", missing: ["totalMs"] });
    expect(turn.hasStoredMetrics()).toBe(false);
  });
});

describe("turnFigures (owner decision r1/Q-3 (a))", () => {
  const names = (f: ReturnType<typeof turnFigures>) =>
    "figures" in f ? Object.fromEntries(f.figures.map((x) => [x.name, x.value])) : f;

  it("gives an error turn that streamed text a TimeToFirstTextMs but no TurnLatencyMs", () => {
    const figures = turnFigures({
      msg: "chat turn",
      replayed: false,
      terminal: "error",
      errorCode: "AGENT_UNAVAILABLE",
      firstTextMs: 900,
      totalMs: 4000,
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(names(figures)).toEqual({
      Turns: 1,
      TurnErrors: 1,
      TimeToFirstTextMs: 900,
      InputTokens: 10,
      OutputTokens: 2,
      CacheReadTokens: 0,
      CacheWriteTokens: 0,
    });
    expect("coded" in figures && figures.coded).toEqual([
      { name: "TurnErrors", code: "AGENT_UNAVAILABLE", value: 1 },
    ]);
  });

  it("groups tool errors by code, UNKNOWN for a failed call with none, and skips unreadable calls", () => {
    const figures = turnFigures({
      msg: "chat turn",
      replayed: false,
      terminal: "done",
      totalMs: 10,
      tools: [
        { ok: false, errorCode: "NOT_FOUND" },
        { ok: true },
        { ok: false, errorCode: "CONFLICT" },
        { ok: false, errorCode: "NOT_FOUND" },
        { ok: false },
        null,
      ],
    });
    expect(names(figures)).toMatchObject({ ToolCalls: 6, ToolErrors: 4 });
    expect("coded" in figures && figures.coded).toEqual([
      { name: "ToolErrors", code: "NOT_FOUND", value: 2 },
      { name: "ToolErrors", code: "CONFLICT", value: 1 },
      { name: "ToolErrors", code: "UNKNOWN", value: 1 },
    ]);
  });

  it("names an error turn with no error code UNKNOWN, and leaves out a token count that isn't a number", () => {
    const figures = turnFigures({
      msg: "chat turn",
      replayed: false,
      terminal: "error",
      totalMs: 10,
      usage: { inputTokens: "many", outputTokens: 2 },
    });
    expect(names(figures)).toEqual({ Turns: 1, TurnErrors: 1, OutputTokens: 2 });
    expect("coded" in figures && figures.coded).toEqual([{ name: "TurnErrors", code: "UNKNOWN", value: 1 }]);
  });

  it("keeps only string IDs", () => {
    const figures = turnFigures({
      msg: "chat turn",
      replayed: true,
      terminal: "done",
      totalMs: 1,
      requestId: "r",
      conversationId: undefined,
      turnId: 7,
    });
    expect("ids" in figures && figures.ids).toEqual({ requestId: "r" });
  });
});

describe("conflictRetryCounter (owner decision r1/Q-6 (a))", () => {
  it("adds one BookingConflictRetries per call to the Env store", () => {
    const metrics = envMetrics("dev");
    const count = conflictRetryCounter(metrics);
    count();
    count();
    metrics.publishStoredMetrics();
    const [record] = records();
    expect(dimensionsOf(record)).toEqual([["Env"]]);
    expect(record).toMatchObject({ BookingConflictRetries: [1, 1] });
  });
});
