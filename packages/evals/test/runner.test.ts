/**
 * What the multi-turn runner hands the model and the simulator: the trial's system prompt (custom or
 * the production one, with the frozen date and the patient's first name), the conversation carried from
 * turn to turn, the simulator's view of the run, and the per-trial accounting. Also how `runSuite`
 * passes its options through, and how a trial skips, errors, injects faults and stops.
 */
import {
  buildSystemPrompt,
  estimateCostUsd,
  ScriptedLlmClient,
  scriptedMalformed,
  scriptedText,
  scriptedToolUse,
  type LlmRequest,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  QueuedPatientSimulator,
  runScenarioTrial,
  runSuite,
  type PatientSimulator,
  type SimulatorContext,
  type SystemPromptFactory,
} from "../src";
import {
  BOOKING_PATIENT,
  byName,
  failedGraders,
  goodBookingSteps,
  l1Case,
  productionInternalError,
  runScripted,
  scenario,
  SCRIPTED_PROFILE as profile,
  withoutCachePoints,
} from "./helpers";
const custom: SystemPromptFactory = (now, name) => ({
  version: "custom.v7",
  stable: "CUSTOM STABLE PROMPT",
  dynamic: `custom: ${now.toISOString()} for ${name}`,
});
const systemText = (r: LlmRequest | undefined) =>
  (r?.system ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
describe("runScenarioTrial", () => {
  it("carries the conversation from turn to turn, append-only (2e22f79/TEST-202)", async () => {
    const llm = new ScriptedLlmClient(goodBookingSteps());
    const r = await runScenarioTrial(scenario("book-derm-next-week-afternoon"), {
      agent: { llm, profile },
      simulator: new QueuedPatientSimulator(BOOKING_PATIENT),
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
    for (const said of BOOKING_PATIENT) expect(lastText).toContain(said);
    expect(lastText).toContain("tool_result");
  });

  it("gives the model the trial's prompt: custom, or the production one with the frozen date and first name (TEST-201, TEST-208)", async () => {
    const s = scenario("safety-emergency-chest-pain-911"); // Walter, clock Mon Oct 5 2026 9:00 AM EDT
    const withCustom = new ScriptedLlmClient([scriptedText("Please call 911 now.")]);
    await runScenarioTrial(s, { agent: { llm: withCustom, profile, systemPrompt: custom } });
    expect(systemText(withCustom.requests[0])).toBe(
      `CUSTOM STABLE PROMPT\ncustom: ${new Date(s.clock).toISOString()} for Walter`,
    );

    const production = new ScriptedLlmClient([scriptedText("Please call 911 now.")]);
    await runScenarioTrial(s, { agent: { llm: production, profile } });
    const text = systemText(production.requests[0]);
    expect(text).toContain(buildSystemPrompt({ now: new Date(s.clock), patientFirstName: "Walter" }).stable);
    expect(text).toContain("Today is Monday, October 5, 2026 (2026-10-05)");
    expect(text).toContain("The patient's first name, from their profile: Walter.");
  });

  it("shows the simulator each turn's number, the last reply, and the events so far (TEST-205)", async () => {
    const seen: SimulatorContext[] = [];
    const queue = [...BOOKING_PATIENT];
    const recording: PatientSimulator = {
      name: "recording",
      next: (ctx) => {
        seen.push({ ...ctx, events: [...ctx.events] });
        const message = queue.shift();
        return Promise.resolve(message === undefined ? { stop: "done" } : { message });
      },
    };
    const r = await runScenarioTrial(scenario("book-derm-next-week-afternoon"), {
      agent: { llm: new ScriptedLlmClient(goodBookingSteps()), profile },
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
      agent: { llm: new ScriptedLlmClient(goodBookingSteps()), profile },
      simulator: new QueuedPatientSimulator(BOOKING_PATIENT),
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
      suite: "smoke",
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
    const llm = new ScriptedLlmClient(goodBookingSteps());
    const report = await runSuite([scenario("book-derm-next-week-afternoon")], {
      mode: "scenario",
      suite: "smoke",
      llm,
      llmName: "scripted",
      profile,
      trials: 1,
      systemPrompt: custom,
      simulator: new QueuedPatientSimulator(BOOKING_PATIENT),
    });
    expect(report.simulator).toBe("queued");
    expect(report.cases[0]?.status).toBe("pass"); // unscripted: it ran only because the simulator got through
    expect(report.promptVersion).toBe("custom.v7");
    expect(systemText(llm.requests[0])).toContain("CUSTOM STABLE PROMPT");
  });

  it("rejects a case that doesn't match the mode", async () => {
    const options = {
      suite: "smoke",
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

describe("runScenarioTrial: skips, errors, faults, limits", () => {
  it("skips surface: api scenarios until the chat handler exists", async () => {
    const r = await runScenarioTrial(scenario("safety-conversation-id-ownership"), {
      agent: { llm: new ScriptedLlmClient([]), profile },
    });
    expect(r).toMatchObject({ status: "skip", reason: expect.stringContaining("#17") as unknown });
  });

  it("skips unscripted scenarios without a simulator", async () => {
    const r = await runScenarioTrial(scenario("book-derm-next-week-afternoon"), {
      agent: { llm: new ScriptedLlmClient([]), profile },
    });
    expect(r).toMatchObject({ status: "skip", reason: expect.stringContaining("#31") as unknown });
  });

  it("reports a model error as an errored trial, not an agent failure", async () => {
    const r = await runScripted("book-derm-next-week-afternoon", [{ error: new Error("throttled") }], ["hi"]);
    expect(r.status).toBe("error");
    expect(r.reason).toContain("throttled");
  });

  it("fault call: all fails every call to the tool, with production's INTERNAL text", async () => {
    const book = (slot: string) =>
      scriptedToolUse([{ name: "book_appointment", input: { slot_id: slot, reason: "lingering cold" } }]);
    const r = await runScripted(
      "escalate-repeated-failure",
      [
        book("slot_brooks_20261012T1300Z"),
        scriptedText("Sorry, let me try again."),
        book("slot_brooks_20261012T1300Z"),
        scriptedText("Sorry."),
      ],
      ["yes book it", "yes"],
    );
    const errors = r.events.flatMap((e) => (e.kind === "tool_call" ? [e.error] : []));
    // The model sees the message and hint; the hint drives escalate-repeated-failure (2e22f79/TEST-204).
    const internal = await productionInternalError();
    expect(errors).toEqual([internal, internal]);
  });

  it("stops at max_turns", async () => {
    const s = scenario("safety-emergency-chest-pain-911");
    const replies = Array.from({ length: s.max_turns + 2 }, () => scriptedText("Please call 911 now."));
    const r = await runScripted(
      s.id,
      replies,
      Array.from({ length: s.max_turns + 2 }, () => "ok"),
    );
    expect(r.turns).toBe(s.max_turns);
    expect(r.stoppedBecause).toBe("max_turns");
  });

  it("trials are isolated: a second trial books the same slot again", async () => {
    const s = scenario("book-derm-next-week-afternoon");
    for (const trial of [1, 2]) {
      const r = await runScenarioTrial(s, {
        trial,
        agent: { llm: new ScriptedLlmClient(goodBookingSteps()), profile },
        simulator: new QueuedPatientSimulator(BOOKING_PATIENT),
      });
      expect(r.status, `trial ${trial}`).toBe("pass");
    }
  });

  it("an invented tool fails trajectory.no_unknown_tools (SPEC-1 decision)", async () => {
    const r = await runScripted(
      "book-derm-next-week-afternoon",
      [scriptedToolUse([{ name: "cancel_appointment", input: {} }]), scriptedText("I can't do that here.")],
      ["cancel my appointment"],
    );
    expect(r.status).toBe("fail");
    expect(failedGraders(r)).toContain("trajectory.no_unknown_tools");
  });

  it("a malformed_output turn is an agent failure, not an error trial (SPEC-1 decision)", async () => {
    const r = await runScripted(
      "book-derm-next-week-afternoon",
      [scriptedMalformed(), scriptedMalformed()],
      ["need a derm appt next week"],
    );
    expect(r.outcomes).toEqual(["malformed_output"]);
    expect(r.llmRetries).toBe(1); // the second malformed response was a retry of the same step
    expect(r.status).toBe("fail");
    expect(byName(r, "turn.outcome")?.detail).toBe("turn 1 ended in malformed_output");
  });

  it("seeds setup.appointments and binds the executor to the scenario's patient", async () => {
    const r = await runScripted(
      "safety-indirect-injection-stored-reason",
      [
        scriptedToolUse([{ name: "get_my_appointments", input: {} }]),
        scriptedText("You have two upcoming appointments."),
      ],
      [],
    );
    const call = r.events.find((e) => e.kind === "tool_call");
    expect(call?.kind === "tool_call" && call.ok).toBe(true);
    const appts = (call as { output: { appointments: { appointment_id: string }[] } }).output.appointments;
    const s = scenario("safety-indirect-injection-stored-reason");
    for (const a of s.setup?.appointments ?? [])
      if (a.patient === s.patient) expect(appts.map((x) => x.appointment_id)).toContain(a.appointment_id);
  });
});
