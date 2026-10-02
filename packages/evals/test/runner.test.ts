/**
 * What the multi-turn runner hands the model and the simulator: the trial's system prompt (custom or
 * the interim one, with the frozen date and the patient's first name), the conversation carried from
 * turn to turn, the simulator's view of the run, and the per-trial accounting. Also how `runSuite`
 * passes its options through.
 */
import {
  estimateCostUsd,
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedText,
  scriptedToolUse,
  type LlmRequest,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  interimSystemPrompt,
  QueuedPatientSimulator,
  runScenarioTrial,
  runSuite,
  type PatientSimulator,
  type SimulatorContext,
  type SystemPromptFactory,
} from "../src";
import { l1Case, scenario } from "./helpers";

const profile = MODEL_PROFILES["gpt-oss-20b"];
const custom: SystemPromptFactory = (now, name) => ({
  version: "custom.v7",
  stable: "CUSTOM STABLE PROMPT",
  dynamic: `custom: ${now.toISOString()} for ${name}`,
});
const systemText = (r: LlmRequest | undefined) =>
  (r?.system ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
const withoutCachePoints = (r: LlmRequest) =>
  r.messages.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== "cache_point") }));

// The good book-derm-next-week-afternoon flow: three patient turns, five model calls.
const STEPS = () => [
  scriptedToolUse([
    {
      name: "check_availability",
      input: {
        provider_id: "prov_okafor",
        date_range: { start_date: "2026-10-15", end_date: "2026-10-15" },
        time_of_day: "afternoon",
      },
    },
  ]),
  scriptedText("Dr. Samuel Okafor has Thursday, October 15, 2026 at 2:00 PM ET. Which works, and why?"),
  scriptedText(
    "To confirm: Dr. Samuel Okafor, Thursday, October 15, 2026 at 2:00 PM ET, for a mole check. Book it?",
  ),
  scriptedToolUse([
    { name: "book_appointment", input: { slot_id: "slot_okafor_20261015T1800Z", reason: "mole check" } },
  ]),
  scriptedText(
    "You're booked with Dr. Samuel Okafor, Thursday, October 15, 2026 at 2:00 PM ET, 400 Cedar Ridge Pkwy.",
  ),
];
const PATIENT = ["derm next week, thursday afternoon", "the 2:00, for a mole check", "Yes, please book it."];

describe("runScenarioTrial", () => {
  it("carries the conversation from turn to turn, append-only (2e22f79/TEST-202)", async () => {
    const llm = new ScriptedLlmClient(STEPS());
    const r = await runScenarioTrial(scenario("book-derm-next-week-afternoon"), {
      agent: { llm, profile },
      simulator: new QueuedPatientSimulator(PATIENT),
    });
    expect(r.status).toBe("pass");
    expect(llm.requests).toHaveLength(5);
    for (const [i, req] of llm.requests.entries()) {
      if (i === 0) continue;
      const prev = llm.requests[i - 1];
      if (prev === undefined) throw new Error("missing request");
      // Each request starts with everything the previous one sent.
      expect(withoutCachePoints(req).slice(0, prev.messages.length)).toEqual(withoutCachePoints(prev));
    }
    const lastText = JSON.stringify(llm.requests.at(-1)?.messages);
    for (const said of PATIENT) expect(lastText).toContain(said);
    expect(lastText).toContain("tool_result");
  });

  it("gives the model the trial's prompt: custom, or the interim one with the frozen date and first name (TEST-201, TEST-208)", async () => {
    const s = scenario("safety-emergency-chest-pain-911"); // Walter, clock Mon Oct 5 2026 9:00 AM EDT
    const withCustom = new ScriptedLlmClient([scriptedText("Please call 911 now.")]);
    await runScenarioTrial(s, { agent: { llm: withCustom, profile, systemPrompt: custom } });
    expect(systemText(withCustom.requests[0])).toBe(
      `CUSTOM STABLE PROMPT\ncustom: ${new Date(s.clock).toISOString()} for Walter`,
    );

    const interim = new ScriptedLlmClient([scriptedText("Please call 911 now.")]);
    await runScenarioTrial(s, { agent: { llm: interim, profile } });
    const text = systemText(interim.requests[0]);
    expect(text).toContain(interimSystemPrompt(new Date(s.clock), "Walter").stable);
    expect(text).toContain("today is Monday, October 5, 2026 (America/New_York)");
    expect(text).toContain("The patient's first name is Walter.");
  });

  it("shows the simulator each turn's number, the last reply, and the events so far (TEST-205)", async () => {
    const seen: SimulatorContext[] = [];
    const queue = [...PATIENT];
    const recording: PatientSimulator = {
      name: "recording",
      next: (ctx) => {
        seen.push({ ...ctx, events: [...ctx.events] });
        const message = queue.shift();
        return Promise.resolve(message === undefined ? { stop: "done" } : { message });
      },
    };
    const r = await runScenarioTrial(scenario("book-derm-next-week-afternoon"), {
      agent: { llm: new ScriptedLlmClient(STEPS()), profile },
      simulator: recording,
    });
    expect(seen.map((c) => c.turn)).toEqual([1, 2, 3, 4]);
    expect(seen[0]?.lastAssistantText).toBe("");
    expect(seen[1]?.lastAssistantText).toMatch(/^Dr\. Samuel Okafor has Thursday/);
    expect(seen[3]?.lastAssistantText).toMatch(/^You're booked/);
    expect(seen[3]?.events).toEqual(r.events);
    expect(r).toMatchObject({ simulator: "recording", stoppedBecause: "done" });
  });

  it("accounts for every model call: usage, calls, cost, per-turn durations (TEST-203)", async () => {
    const r = await runScenarioTrial(scenario("book-derm-next-week-afternoon"), {
      agent: { llm: new ScriptedLlmClient(STEPS()), profile },
      simulator: new QueuedPatientSimulator(PATIENT),
    });
    // ScriptedLlmClient reports 100 input / 20 output tokens per call.
    const usage = { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(r).toMatchObject({ turns: 3, llmCalls: 5, llmRetries: 0, usage });
    expect(r.costUsd).toBeCloseTo(estimateCostUsd(profile, usage), 12);
    expect(r.turnDurationsMs).toHaveLength(3);
    expect(r.outcomes).toEqual(["completed", "completed", "completed"]);
  });
});

describe("runSuite passes its options through (TEST-201, TEST-207)", () => {
  it("L1: trials and the report use the same custom prompt", async () => {
    const llm = new ScriptedLlmClient([scriptedText("Please call or text 988 now.")]);
    const report = await runSuite([l1Case("l1-crisis-988")], {
      mode: "l1",
      suite: "test",
      llm,
      llmName: "scripted",
      profile,
      trials: 1,
      systemPrompt: custom,
    });
    expect(report.promptVersion).toBe("custom.v7");
    expect(systemText(llm.requests[0])).toContain("CUSTOM STABLE PROMPT");
  });

  it("scenario: the prompt and the simulator reach the trials", async () => {
    const llm = new ScriptedLlmClient(STEPS());
    const report = await runSuite([scenario("book-derm-next-week-afternoon")], {
      mode: "scenario",
      suite: "test",
      llm,
      llmName: "scripted",
      profile,
      trials: 1,
      systemPrompt: custom,
      simulator: new QueuedPatientSimulator(PATIENT),
    });
    expect(report.simulator).toBe("queued");
    expect(report.cases[0]?.status).toBe("pass"); // unscripted: it ran only because the simulator got through
    expect(report.promptVersion).toBe("custom.v7");
    expect(systemText(llm.requests[0])).toContain("CUSTOM STABLE PROMPT");
  });

  it("rejects a case that doesn't match the mode", async () => {
    const options = {
      suite: "test",
      llm: new ScriptedLlmClient([]),
      llmName: "scripted",
      profile,
      trials: 1,
    } as const;
    await expect(runSuite([l1Case("l1-crisis-988")], { ...options, mode: "scenario" })).rejects.toThrow(
      "l1-crisis-988 is not a scenario",
    );
    await expect(
      runSuite([scenario("safety-emergency-chest-pain-911")], { ...options, mode: "l1" }),
    ).rejects.toThrow("safety-emergency-chest-pain-911 is not an L1 case");
  });
});
