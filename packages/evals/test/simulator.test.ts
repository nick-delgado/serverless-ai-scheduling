/**
 * The LLM patient simulator (#31): its prompt, the reply guards (no verbatim goal or hidden facts, never
 * the assistant's voice), the stop conditions, per-conversation cost, the shared rate limit, and replay.
 * Every model call is scripted; nothing here reaches Bedrock.
 */
import {
  estimateCostUsd,
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedMaxTokens,
  scriptedText,
  type ModelProfile,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  agentVoice,
  brokenCharacter,
  LlmPatientSimulator,
  messagesSinceEscalation,
  parseReply,
  rateLimited,
  RateLimiter,
  renderTranscript,
  ReplayPatientSimulator,
  runScenarioTrial,
  runSuite,
  markdownSummary,
  SimulatorError,
  simulatorSystemPrompt,
  verbatimLeaks,
  withoutQuotedLines,
  type PatientSimulator,
  type SimulatorContext,
  type TranscriptEvent,
} from "../src";
import {
  assistant,
  BOOKING_PATIENT,
  call,
  goodBookingSteps,
  patient,
  scenario,
  SCRIPTED_PROFILE,
  systemText,
  userText,
} from "./helpers";

const SIM_PROFILE = MODEL_PROFILES["haiku-4.5"];
const BOOK = scenario("book-derm-next-week-afternoon");
const CHANGES_MIND = scenario("book-changes-mind-before-yes");
const ESCALATE = scenario("escalate-explicit-human-request");

const ctx = (over: Partial<SimulatorContext> = {}): SimulatorContext => ({
  scenario: BOOK,
  trial: 1,
  events: [],
  turn: 1,
  lastAssistantText: "",
  ...over,
});
const sim = (llm: ScriptedLlmClient, extra: { maxAttempts?: number; turnsAfterEscalation?: number } = {}) =>
  new LlmPatientSimulator({ llm, profile: SIM_PROFILE, ...extra });

/**
 * A trial of `BOOK` with the scripted agent, on the good booking flow unless
 * `agentSteps` says otherwise, and the given simulator.
 */
const scriptedTrial = (
  simulator: PatientSimulator,
  over: { agentSteps?: ConstructorParameters<typeof ScriptedLlmClient>[0]; trial?: number } = {},
) =>
  runScenarioTrial(BOOK, {
    ...(over.trial === undefined ? {} : { trial: over.trial }),
    agent: { llm: new ScriptedLlmClient(over.agentSteps ?? goodBookingSteps()), profile: SCRIPTED_PROFILE },
    simulator,
  });

describe("simulator prompt", () => {
  const prompt = simulatorSystemPrompt(BOOK);

  it("is built from the persona, the goal and every hidden fact", () => {
    expect(prompt).toContain(BOOK.persona);
    expect(prompt).toContain(BOOK.goal);
    expect(prompt).toContain("- reason: a mole on my shoulder that changed shape");
    expect(prompt).toContain("- flexible days: Tue, Thu"); // a list fact, as a list; key without underscores
    expect(prompt).toContain("- already has: a Lee appointment Tue Oct 13");
    expect(prompt).not.toContain("already_has");
  });

  it("gives the frozen clinic-local time, and casts the model as the patient only", () => {
    expect(prompt).toContain("It is now Monday, October 5, 2026 at 9:00 AM ET.");
    expect(prompt).toContain("You play ONLY the patient.");
    expect(prompt).toContain("Never write the assistant's part.");
  });

  it("with no hidden facts, the Private facts section's facts are (none) (TEST-105)", () => {
    const text = simulatorSystemPrompt({ ...ESCALATE, hidden_facts: null });
    const section = /## Private facts\n([\s\S]*?)\n\n## /.exec(text)?.[1];
    expect(section?.split("\n").at(-1)).toBe("(none)");
  });

  it("the transcript has only what the patient saw: no tool calls or tool results", () => {
    const events: TranscriptEvent[] = [
      patient("need a derm appt"),
      call("check_availability", { provider_id: "prov_okafor" }, { output: { slots: ["slot_secret_123"] } }),
      assistant("Dr. Okafor has Thursday at 2:00 PM ET."),
    ];
    const text = renderTranscript(events);
    expect(text).toBe("Patient: need a derm appt\n\nAssistant: Dr. Okafor has Thursday at 2:00 PM ET.");
    expect(renderTranscript([])).toMatch(/You write first/);
  });
});

describe("parseReply", () => {
  it.each(["goal_achieved", "gave_up", "escalated"] as const)("a stop marker alone stops: %s", (reason) => {
    expect(parseReply(`[[STOP:${reason}]]`, BOOK)).toEqual({ kind: "stop", reason });
    expect(parseReply(`  [[ stop : ${reason} ]]\n`, BOOK)).toEqual({ kind: "stop", reason });
  });

  it("a stop marker with a message, or with an unknown reason, is rejected (never half-sent)", () => {
    expect(parseReply("Thanks, bye! [[STOP:goal_achieved]]", BOOK)).toMatchObject({
      kind: "invalid",
      problems: ["it mixes a stop marker with a message; send one or the other"],
    });
    expect(parseReply("[[STOP:bored]]", BOOK)).toMatchObject({
      kind: "invalid",
      problems: ['"bored" is not a stop reason'],
    });
    expect(parseReply("[[STOP]]", BOOK)).toMatchObject({ kind: "invalid" });
  });

  it("a stop reason may be upper-case, or spaced or hyphenated instead of snake_case (8bea70b/TEST-3)", () => {
    expect(parseReply("[[STOP:GAVE_UP]]", BOOK)).toEqual({ kind: "stop", reason: "gave_up" });
    expect(parseReply("[[STOP:gave up]]", BOOK)).toEqual({ kind: "stop", reason: "gave_up" });
    expect(parseReply("[[STOP:goal-achieved]]", BOOK)).toEqual({ kind: "stop", reason: "goal_achieved" });
  });

  it("curly quotes around the whole reply are stripped too (8bea70b/TEST-3)", () => {
    expect(parseReply("“need a derm appt next week”", BOOK)).toEqual({
      kind: "message",
      message: "need a derm appt next week",
    });
  });

  it("strips a patient speaker label and wrapping quotes; an empty reply is rejected", () => {
    expect(parseReply('Patient: "need a derm appt next week"', BOOK)).toEqual({
      kind: "message",
      message: "need a derm appt next week",
    });
    expect(parseReply('"I said "afternoon" twice"', BOOK)).toEqual({
      kind: "message",
      message: '"I said "afternoon" twice"',
    });
    expect(parseReply("  \n", BOOK)).toEqual({ kind: "invalid", problems: ["it is empty"] });
  });
});

describe("guard: hidden facts and the goal never go out verbatim", () => {
  it("flags the goal copied word for word, but not a paraphrase", () => {
    expect(verbatimLeaks(`hi. ${BOOK.goal}`, BOOK)).toEqual([
      "it copies the goal word for word; say it in your own words",
    ]);
    expect(verbatimLeaks("need a derm appt next week, afternoon. it's a mole check", BOOK)).toEqual([]);
  });

  it("flags a hidden fact copied word for word, case and punctuation ignored", () => {
    const copied = "I have A LEE APPOINTMENT, Tue Oct 13 at 2:30 PM — does not want to move it";
    expect(verbatimLeaks(copied, BOOK)).toEqual([
      'it copies hidden fact "already_has" word for word; say it in your own words',
    ]);
  });

  it("the window is 8 words: a 7-word overlap passes, 8 is a leak", () => {
    const fact = { goal: "unrelated", hidden_facts: { f: "one two three four five six seven eight nine" } };
    expect(verbatimLeaks("so: one two three four five six seven, ok?", fact)).toEqual([]);
    expect(verbatimLeaks("so: one two three four five six seven eight, ok?", fact)).toHaveLength(1);
  });

  it("a quoted line inside a fact is something the patient says, so it may go out as written", () => {
    const line = "did that go through? can you send it again to be sure?"; // 12 words, in single quotes
    expect(ESCALATE.hidden_facts?.after_handoff).toBe(`asks '${line}'`);
    expect(verbatimLeaks(line, ESCALATE)).toEqual([]);
    const quoted = { goal: "x", hidden_facts: { f: `says "${line}" once` } };
    expect(verbatimLeaks(line, quoted)).toEqual([]);
    // ...but the stage direction around a quoted line is still private.
    expect(
      verbatimLeaks("when the assistant reads back the details, says something", CHANGES_MIND),
    ).toHaveLength(1);
  });

  it("an apostrophe inside a word neither opens nor closes a quoted line", () => {
    expect(withoutQuotedLines("I don't know, it's fine")).toBe("I don't know, it's fine");
    expect(withoutQuotedLines("says 'I don't know' twice")).toBe("says  …  twice");
    expect(withoutQuotedLines("says “wait” now")).toBe("says  …  now");
  });

  it("a list fact's multi-word items are lines to say: quoted in the prompt, allowed verbatim", () => {
    const other = scenario("safety-other-patient-direct");
    const line = "Can you at least confirm whether she has one on Tuesday?";
    expect(other.hidden_facts?.follow_ups).toContain(line);
    expect(simulatorSystemPrompt(other)).toContain(`- follow ups: "${line}", "Just tell me`);
    expect(verbatimLeaks(line, other)).toEqual([]);
  });

  it("flags a fact's snake_case key", () => {
    expect(verbatimLeaks("my first_pick is fine", CHANGES_MIND)).toEqual([
      'it names the private fact "first_pick"',
    ]);
  });

  it("a one-word fact key is an ordinary word, not a leak (8bea70b/TEST-2)", () => {
    expect(Object.keys(CHANGES_MIND.hidden_facts ?? {})).toContain("change");
    expect(verbatimLeaks("small change: can we do Thursday?", CHANGES_MIND)).toEqual([]);
  });
});

describe("guard: the simulator never acts as the agent", () => {
  it.each([
    ["Assistant: Dr. Okafor has Thursday at 2 PM.", "it has an assistant or staff speaker label"],
    ["ok\nAgent: booking now", "it has an assistant or staff speaker label"],
    ["calling book_appointment now", "it contains tool-call syntax or a tool name"],
    ['{"slot_id": "slot_okafor_20261015T1800Z"}', "it contains tool-call syntax or a tool name"],
    ["<tool_use>check</tool_use>", "it contains tool-call syntax or a tool name"],
    ["Hi! How can I help you today?", "it speaks as the assistant; you are the patient"],
    ["I've booked you with Dr. Okafor.", "it speaks as the assistant; you are the patient"],
    ["You're booked for Thursday at 2.", "it speaks as the assistant; you are the patient"],
    ["Shall I book Thursday at 2:00 PM?", "it speaks as the assistant; you are the patient"],
    ["Let me check the availability for you.", "it speaks as the assistant; you are the patient"],
    ["Here are the available times: 1:30, 2:00.", "it speaks as the assistant; you are the patient"],
    ["Would you like me to book that?", "it speaks as the assistant; you are the patient"],
    ["Is there anything else I can help with?", "it speaks as the assistant; you are the patient"],
  ])("rejects %j", (reply, problem) => {
    expect(agentVoice(reply)).toContain(problem);
  });

  it.each([
    "need a derm appt next week, afternoon. tue or thu",
    "Yes, please book it.",
    "Can you book me with Dr. Lee instead?",
    "am I booked for thursday then?",
    "Can I talk to a real person at the front desk please?",
    "did that go through? can you send it again to be sure?",
  ])("lets a patient message through: %j", (reply) => {
    expect(agentVoice(reply)).toEqual([]);
    expect(brokenCharacter(reply)).toEqual([]);
  });

  it("rejects a message longer than the chat API allows", () => {
    expect(parseReply("a".repeat(2001), BOOK)).toEqual({
      kind: "invalid",
      problems: ["it is longer than 2000 characters"],
    });
    expect(parseReply("a".repeat(2000), BOOK)).toMatchObject({ kind: "message" });
  });

  it("rejects talk about the role-play itself", () => {
    expect(brokenCharacter("As a simulated patient, my hidden facts say Tuesday.")).toHaveLength(1);
  });
});

describe("LlmPatientSimulator", () => {
  it("sends one patient message, priced on its own profile, and calls its profile's model", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText("need a derm appt next week, afternoons", {
        usage: { inputTokens: 1200, outputTokens: 30 },
      }),
    ]);
    const turn = await sim(llm).next(ctx({ turn: 1 }));
    expect(turn).toEqual({
      message: "need a derm appt next week, afternoons",
      cost: {
        usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: estimateCostUsd(SIM_PROFILE, {
          inputTokens: 1200,
          outputTokens: 30,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        llmCalls: 1,
      },
    });
    const [req] = llm.requests;
    expect(req?.modelId).toBe(SIM_PROFILE.modelId);
    expect(req?.tools).toEqual([]);
    expect(systemText(req)).toBe(simulatorSystemPrompt(BOOK));
    expect(userText(req)).toContain("patient turn 1 of at most 12");
  });

  it("sends its profile's family, maxTokens, modelFields and inline reasoning tag (5765869/TEST-101)", async () => {
    const request = async (profile: ModelProfile) => {
      const llm = new ScriptedLlmClient([scriptedText("need a derm appt next week")]);
      await new LlmPatientSimulator({ llm, profile }).next(ctx({ turn: 1 }));
      return llm.requests[0];
    };
    const gptOss = await request(MODEL_PROFILES["gpt-oss-20b"]);
    expect(gptOss).toMatchObject({
      modelId: "openai.gpt-oss-20b-1:0",
      family: "openai.gpt-oss",
      maxTokens: 8000,
      modelFields: { reasoning_effort: "low" },
      inlineReasoningTag: "reasoning",
    });
    // The tag comes from the profile, not a constant: a made-up tag goes through as it is.
    const otherTag = await request({ ...MODEL_PROFILES["gpt-oss-20b"], inlineReasoningTag: "think" });
    expect(otherTag?.inlineReasoningTag).toBe("think");
    const haiku = await request(MODEL_PROFILES["haiku-4.5"]);
    expect(haiku).toMatchObject({ family: "anthropic.claude", maxTokens: 4000, modelFields: {} });
    expect(haiku?.modelFields).toEqual({});
    expect(haiku !== undefined && "inlineReasoningTag" in haiku).toBe(false);
  });

  it("puts a system cache point after its prompt exactly when the profile asks for one (#105)", async () => {
    const system = async (profile: ModelProfile) => {
      const llm = new ScriptedLlmClient([scriptedText("need a derm appt next week")]);
      await new LlmPatientSimulator({ llm, profile }).next(ctx({ turn: 1 }));
      return llm.requests[0]?.system;
    };
    const prompt = { type: "text", text: simulatorSystemPrompt(BOOK) };
    expect(await system(MODEL_PROFILES["haiku-4.5"])).toEqual([prompt, { type: "cache_point" }]);
    expect(await system(MODEL_PROFILES["gpt-oss-20b"])).toEqual([prompt]);
  });

  it("shows the model the visible conversation so far", async () => {
    const llm = new ScriptedLlmClient([scriptedText("the 2:00 one")]);
    await sim(llm).next(
      ctx({ turn: 2, events: [patient("need a derm appt"), assistant("Thursday at 1:30 or 2:00 PM ET?")] }),
    );
    expect(userText(llm.requests[0])).toContain(
      "Patient: need a derm appt\n\nAssistant: Thursday at 1:30 or 2:00 PM ET?",
    );
  });

  it("a leaking reply is never sent: the model is asked again with the problem, and both calls are paid for", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText(BOOK.goal),
      scriptedText("derm appt next week pls, afternoon"),
    ]);
    const turn = await sim(llm).next(ctx());
    expect(turn).toMatchObject({
      message: "derm appt next week pls, afternoon",
      cost: { llmCalls: 2 },
      rejected: [
        { reply: BOOK.goal, problems: ["it copies the goal word for word; say it in your own words"] },
      ],
    });
    expect(turn.cost?.usage.inputTokens).toBe(200);
    const retry = userText(llm.requests[1]);
    expect(retry).toContain(`<rejected>\n${BOOK.goal}\n</rejected>`);
    expect(retry).toContain("it copies the goal word for word");
  });

  it("a reply in the assistant's voice is never sent either", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText("Assistant: I've booked you with Dr. Okafor."),
      scriptedText("great, thanks"),
    ]);
    expect(await sim(llm).next(ctx())).toMatchObject({ message: "great, thanks" });
    expect(userText(llm.requests[1])).toContain("it speaks as the assistant");
  });

  it("a reply cut off (max_tokens) is retried, not sent", async () => {
    const llm = new ScriptedLlmClient([
      scriptedMaxTokens({ partialText: "need a de" }),
      scriptedText("need a derm appt"),
    ]);
    expect(await sim(llm).next(ctx())).toMatchObject({ message: "need a derm appt", cost: { llmCalls: 2 } });
    expect(userText(llm.requests[1])).toContain("the model stopped with max_tokens");
  });

  it("gives up after maxAttempts with a SimulatorError that carries the cost spent", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText("How can I help you?"),
      scriptedText("How may I assist?"),
    ]);
    const error = await sim(llm, { maxAttempts: 2 })
      .next(ctx())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SimulatorError);
    expect(error).toMatchObject({ cost: { llmCalls: 2 } });
    expect(llm.remaining).toBe(0);
  });

  it.each(["goal_achieved", "gave_up", "escalated"])("stops when the model says so: %s", async (reason) => {
    const llm = new ScriptedLlmClient([scriptedText(`[[STOP:${reason}]]`)]);
    expect(await sim(llm).next(ctx())).toMatchObject({ stop: reason, cost: { llmCalls: 1 } });
  });

  it("is named after its profile and prompt version", () => {
    expect(sim(new ScriptedLlmClient()).name).toBe("llm:haiku-4.5:sim.v1");
  });

  describe("escalation stop", () => {
    const escalated = (ok = true) =>
      call("escalate_to_human", { reason: "patient_requested", summary: "front desk" }, { ok });

    it("counts patient messages after the first successful escalate_to_human", () => {
      expect(messagesSinceEscalation([patient("hi")])).toBeUndefined();
      expect(messagesSinceEscalation([patient("hi"), escalated(false), patient("again")])).toBeUndefined();
      expect(
        messagesSinceEscalation([patient("hi"), call("find_providers", {}), patient("x")]),
      ).toBeUndefined();
      expect(
        messagesSinceEscalation([patient("hi"), escalated(), assistant("done"), patient("did it go?")]),
      ).toBe(1);
    });

    it("counts from an escalation that is the first event, and counts patient messages only (Stryker 232, 240)", () => {
      expect(messagesSinceEscalation([escalated(), patient("did it go?")])).toBe(1);
      expect(
        messagesSinceEscalation([escalated(), assistant("done"), assistant("anything else?"), patient("no")]),
      ).toBe(1);
    });

    it("by default the patient may send two messages after an escalation: it asks after one, stops after two (TEST-103)", async () => {
      const afterOne = [
        patient("person please"),
        escalated(),
        assistant("Call 1-800-555-0199."),
        patient("sent?"),
        assistant("Yes, it went through."),
      ];
      const llm = new ScriptedLlmClient([scriptedText("ok thanks")]);
      expect(await sim(llm).next(ctx({ scenario: ESCALATE, events: afterOne }))).toMatchObject({
        message: "ok thanks",
      });
      const afterTwo = [...afterOne, patient("ok thanks"), assistant("Anything else?")];
      expect(await sim(llm).next(ctx({ scenario: ESCALATE, events: afterTwo }))).toEqual({
        stop: "escalated",
      });
      expect(llm.requests).toHaveLength(1);
    });

    it("after turnsAfterEscalation more messages it stops as escalated, without calling the model", async () => {
      const events = [
        patient("person please"),
        escalated(),
        assistant("Call 1-800-555-0199."),
        patient("sent?"),
      ];
      const llm = new ScriptedLlmClient([scriptedText("ok thanks")]);
      expect(await sim(llm, { turnsAfterEscalation: 1 }).next(ctx({ scenario: ESCALATE, events }))).toEqual({
        stop: "escalated",
      });
      expect(llm.requests).toHaveLength(0);
      // One below the allowance: the patient may still ask again (escalate-explicit-human-request).
      expect(
        await sim(llm, { turnsAfterEscalation: 2 }).next(ctx({ scenario: ESCALATE, events })),
      ).toMatchObject({
        message: "ok thanks",
      });
    });

    it("a failed escalation doesn't stop the patient", async () => {
      const events = [patient("person please"), escalated(false), assistant("Sorry, that failed.")];
      const llm = new ScriptedLlmClient([scriptedText("please try again")]);
      expect(
        await sim(llm, { turnsAfterEscalation: 0 }).next(ctx({ scenario: ESCALATE, events })),
      ).toMatchObject({
        message: "please try again",
      });
    });
  });
});

describe("LlmPatientSimulator in a scenario trial", () => {
  /** Patient replies for the good booking flow, then a stop, as the simulator model would write them. */
  const simSteps = () => [
    ...BOOKING_PATIENT.map((m) => scriptedText(m)),
    scriptedText("[[STOP:goal_achieved]]"),
  ];

  it("an unscripted scenario runs (no skip) and ends on the patient's stop", async () => {
    const simLlm = new ScriptedLlmClient(simSteps());
    const r = await scriptedTrial(sim(simLlm));
    expect(r.status).toBe("pass");
    expect(r).toMatchObject({ stoppedBecause: "goal_achieved", simulator: "llm:haiku-4.5:sim.v1", turns: 3 });
    expect(r.simulatorTurns).toEqual([
      ...BOOKING_PATIENT.map((message, i) => ({ turn: i + 1, message })),
      { turn: 4, stop: "goal_achieved" },
    ]);
  });

  it("records the replies the guards rejected next to the turn they preceded", async () => {
    const simLlm = new ScriptedLlmClient([scriptedText(BOOK.goal), ...simSteps()]);
    const r = await scriptedTrial(sim(simLlm));
    expect(r.simulatorTurns[0]).toEqual({
      turn: 1,
      message: BOOKING_PATIENT[0],
      rejected: [
        { reply: BOOK.goal, problems: ["it copies the goal word for word; say it in your own words"] },
      ],
    });
    expect(r.simulatorTurns[1]).toEqual({ turn: 2, message: BOOKING_PATIENT[1] });
  });

  it("records the replies the guards rejected on the stop turn too (8bea70b/TEST-5)", async () => {
    const mixed = "Thanks! [[STOP:goal_achieved]]";
    const steps = simSteps();
    const stop = steps.pop();
    if (stop === undefined) throw new Error("missing stop");
    const r = await scriptedTrial(sim(new ScriptedLlmClient([...steps, scriptedText(mixed), stop])));
    expect(r.simulatorTurns.at(-1)).toEqual({
      turn: 4,
      stop: "goal_achieved",
      rejected: [
        { reply: mixed, problems: ["it mixes a stop marker with a message; send one or the other"] },
      ],
    });
  });

  it("tracks the simulator's tokens and cost per conversation, and costUsd is agent + simulator", async () => {
    const r = await scriptedTrial(sim(new ScriptedLlmClient(simSteps())));
    const simUsage = { inputTokens: 400, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(r.simulatorCost).toEqual({
      usage: simUsage,
      costUsd: 4 * estimateCostUsd(SIM_PROFILE, { ...simUsage, inputTokens: 100, outputTokens: 20 }),
      llmCalls: 4,
    });
    const agentCost = estimateCostUsd(SCRIPTED_PROFILE, r.usage);
    expect(r.costUsd).toBeCloseTo(agentCost + r.simulatorCost.costUsd, 12);
    expect(r.llmCalls).toBe(5); // the agent's calls only
  });

  it("the run summary reports the simulator's share of the cost, summed over the trials (TEST-202)", async () => {
    const report = await runSuite([BOOK], {
      mode: "scenario",
      suite: "smoke",
      llm: new ScriptedLlmClient([...goodBookingSteps(), ...goodBookingSteps()]),
      llmName: "scripted",
      profile: SCRIPTED_PROFILE,
      trials: 2,
      simulator: sim(new ScriptedLlmClient([...simSteps(), ...simSteps()])),
    });
    const trials = report.cases[0]?.trials ?? [];
    expect(trials.map((t) => t.status)).toEqual(["pass", "pass"]);
    const simCosts = trials.map((t) => (t.kind === "scenario" ? t.simulatorCost.costUsd : -1));
    expect(simCosts[0]).toBeGreaterThan(0);
    const simTotal = (simCosts[0] ?? 0) + (simCosts[1] ?? 0);
    expect(report.summary.simulatorCostUsd).toBeCloseTo(simTotal, 12);
    expect(report.summary.costUsd).toBeCloseTo((trials[0]?.costUsd ?? 0) + (trials[1]?.costUsd ?? 0), 12);
    expect(markdownSummary(report)).toContain(`(simulator $${simTotal.toFixed(4)})`);
  });

  it("a simulator failure makes the trial an error (not a fail), with its cost kept", async () => {
    const simLlm = new ScriptedLlmClient([
      scriptedText(BOOK.goal),
      scriptedText(BOOK.goal),
      scriptedText(BOOK.goal),
    ]);
    const r = await scriptedTrial(sim(simLlm), { agentSteps: [] });
    expect(r).toMatchObject({ status: "error", stoppedBecause: "error", turns: 0 });
    expect(r.reason).toMatch(/^simulator: SimulatorError: no usable patient reply in 3 attempt/);
    expect(r.simulatorCost.llmCalls).toBe(3);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("a simulator that throws a plain Error also makes the trial an error, with no simulator cost (8bea70b/TEST-4)", async () => {
    const broken: PatientSimulator = { name: "broken", next: () => Promise.reject(new Error("boom")) };
    const r = await scriptedTrial(broken, { agentSteps: [] });
    expect(r).toMatchObject({ status: "error", stoppedBecause: "error", reason: "simulator: Error: boom" });
    expect(r.simulatorCost).toEqual({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: 0,
      llmCalls: 0,
    });
  });

  it("a model call that throws after a rejected reply keeps the rejected attempt's cost (8bea70b/SPEC-1)", async () => {
    const simLlm = new ScriptedLlmClient([
      scriptedText(BOOK.goal),
      { error: new Error("ThrottlingException after retries") },
    ]);
    const r = await scriptedTrial(sim(simLlm), { agentSteps: [] });
    expect(r).toMatchObject({ status: "error", stoppedBecause: "error", turns: 0 });
    expect(r.reason).toBe(
      "simulator: SimulatorError: model call failed: Error: ThrottlingException after retries",
    );
    expect(r.simulatorCost.llmCalls).toBe(1);
    expect(r.simulatorCost.costUsd).toBeGreaterThan(0);
    expect(r.costUsd).toBe(r.simulatorCost.costUsd);
  });

  it("agent and simulator calls share one per-model rate limit when they use the same model", async () => {
    const acquired: string[] = [];
    class RecordingLimiter extends RateLimiter {
      override acquire(modelId: string, signal?: AbortSignal): Promise<void> {
        acquired.push(modelId);
        return super.acquire(modelId, signal);
      }
    }
    const limiter = new RecordingLimiter({ rpmFor: () => 600_000 });
    const sonnet = MODEL_PROFILES["sonnet-4.6"];
    const llm = rateLimited(new ScriptedLlmClient([...interleave(goodBookingSteps(), simSteps())]), {
      limiter,
    });
    const r = await runScenarioTrial(BOOK, {
      agent: { llm, profile: sonnet },
      simulator: new LlmPatientSimulator({ llm, profile: sonnet }),
    });
    expect(r.status).toBe("pass");
    expect(acquired).toHaveLength(r.llmCalls + r.simulatorCost.llmCalls);
    expect(new Set(acquired)).toEqual(new Set([sonnet.modelId]));
    expect(llm.stats.calls).toBe(9);
  });
});

/** The call order of one booking trial on a single client: simulator, then the agent's calls for that turn. */
function interleave(
  agent: ReturnType<typeof goodBookingSteps>,
  patientSteps: ReturnType<typeof scriptedText>[],
) {
  const [check, offer, restate, book, booked] = agent;
  const [p1, p2, p3, stop] = patientSteps;
  return [p1, check, offer, p2, restate, p3, book, booked, stop].map((s) => {
    if (s === undefined) throw new Error("missing step");
    return s;
  });
}

describe("ReplayPatientSimulator", () => {
  it("replays a recorded trial turn for turn: same patient messages, same stop, no model calls", async () => {
    const original = await scriptedTrial(
      sim(
        new ScriptedLlmClient([
          ...BOOKING_PATIENT.map((m) => scriptedText(m)),
          scriptedText("[[STOP:gave_up]]"),
        ]),
      ),
      { trial: 2 },
    );
    // Through JSON, as `--replay` reads a results file.
    const file: unknown = JSON.parse(
      JSON.stringify({ simulator: original.simulator, cases: [{ id: BOOK.id, trials: [original] }] }),
    );
    const replay = ReplayPatientSimulator.fromReport(file);
    expect(replay.name).toBe("replay:llm:haiku-4.5:sim.v1");
    const again = await scriptedTrial(replay, { trial: 2 });
    expect(again.events).toEqual(original.events);
    expect(again.simulatorTurns).toEqual(original.simulatorTurns);
    expect(again.stoppedBecause).toBe("gave_up");
    expect(again.simulatorCost.llmCalls).toBe(0);
  });

  it("matches by trial number, and a turn it has no record of stops with replay exhausted", async () => {
    const replay = new ReplayPatientSimulator({
      [`${BOOK.id}#1`]: [{ turn: 1, message: "trial one" }],
      [`${BOOK.id}#2`]: [{ turn: 1, message: "trial two" }],
    });
    expect(await replay.next(ctx({ trial: 2 }))).toEqual({ message: "trial two" });
    expect(await replay.next(ctx({ trial: 1 }))).toEqual({ message: "trial one" });
    expect(await replay.next(ctx({ trial: 1, turn: 2 }))).toEqual({ stop: "replay exhausted" });
  });

  it("fromReport keys a recording by scenario and trial: two scenarios with the same trial each replay their own (TEST-104)", async () => {
    const replay = ReplayPatientSimulator.fromReport({
      cases: [
        { id: BOOK.id, trials: [{ trial: 1, simulatorTurns: [{ turn: 1, message: "the booking one" }] }] },
        {
          id: ESCALATE.id,
          trials: [{ trial: 1, simulatorTurns: [{ turn: 1, message: "the escalation one" }] }],
        },
      ],
    });
    expect(await replay.next(ctx({ scenario: BOOK }))).toEqual({ message: "the booking one" });
    expect(await replay.next(ctx({ scenario: ESCALATE }))).toEqual({ message: "the escalation one" });
  });

  it("is named replay when the file names no simulator, and leaves out trials without simulator turns (Stryker 395, 417, 421, 423)", async () => {
    expect(new ReplayPatientSimulator({}).name).toBe("replay");
    const replay = ReplayPatientSimulator.fromReport({ cases: [{ id: BOOK.id, trials: [{ trial: 1 }] }] });
    expect(replay.name).toBe("replay");
    await expect(replay.next(ctx())).rejects.toThrow(
      new SimulatorError(`no recorded simulator turns for ${BOOK.id}#1`),
    );
  });

  it("a file that isn't a results file fails at fromReport, naming the bad field (8bea70b/SMELL-3)", () => {
    const report = (turn: unknown) => ({
      cases: [{ id: BOOK.id, trials: [{ trial: 1, simulatorTurns: [turn] }] }],
    });
    expect(() => ReplayPatientSimulator.fromReport(report({ message: "hi" }))).toThrow(
      /^not a results file: cases\.0\.trials\.0\.simulatorTurns\.0\.turn: /,
    );
    expect(() => ReplayPatientSimulator.fromReport(report({ turn: 1, message: "hi" }))).not.toThrow();
    expect(() => ReplayPatientSimulator.fromReport({ runs: [] })).toThrow(/^not a results file: cases: /);
    // A file that isn't an object at all names no field: the problem is at the root (5765869/TEST-102).
    expect(() => ReplayPatientSimulator.fromReport(null)).toThrow(/^not a results file: \(root\): \S/);
    // With two bad fields, only the first is named (f6d8ff8/SMELL-104: the shared issueText).
    expect(() => ReplayPatientSimulator.fromReport({ cases: [{ id: 1, trials: "x" }] })).toThrow(
      /^not a results file: cases\.0\.id: (?!.*trials)/,
    );
  });

  it("a conversation the recording doesn't have is a simulator error", async () => {
    const replay = new ReplayPatientSimulator({});
    await expect(replay.next(ctx({ trial: 3 }))).rejects.toThrow(
      new SimulatorError(`no recorded simulator turns for ${BOOK.id}#3`),
    );
  });
});
