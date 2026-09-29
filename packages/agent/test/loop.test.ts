import type Anthropic from "@anthropic-ai/sdk";
import { ChatStreamEvent, TOOL_STATUS_LABELS, ToolError, TurnTrace } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { describe, expect, it } from "vitest";

import {
  FALLBACK_MESSAGES,
  MODEL_PROFILES,
  runAgentTurn,
  ScriptedLlmClient,
  scriptedMaxTokens,
  scriptedRefusal,
  scriptedText,
  scriptedToolUse,
  TEXT_BLOCK_SEPARATOR,
} from "../src";
import {
  allKeys,
  availability,
  contentOf,
  deepFreeze,
  fakeExecutor,
  PATIENT_ID,
  SYSTEM,
  sleep,
  textDeltas,
  toolResults,
  turnInput,
  valuesForKey,
} from "./helpers";

const sonnet = MODEL_PROFILES["sonnet-4.6"];
const haiku = MODEL_PROFILES["haiku-4.5"];
const CHECK = { name: "check_availability", input: EXAMPLES.CheckAvailabilityInput } as const;

describe("runAgentTurn: stop_reason end_turn", () => {
  it("answers directly, streams the text, and returns the new messages", async () => {
    const llm = new ScriptedLlmClient([scriptedText("Hi Maria! How can I help you today?")]);
    const input = turnInput(llm, { userMessage: "Hello" });

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("Hi Maria! How can I help you today?");
    expect(textDeltas(input.events)).toBe(result.text);
    expect(input.events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(1); // streamed, not one blob
    expect(result.newMessages).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi Maria! How can I help you today?", citations: null }],
      },
    ]);
    expect(llm.requests).toHaveLength(1);
    expect(result.trace.iterations).toBe(1);
  });

  it("does not store an empty reply (the API rejects empty assistant messages in history)", async () => {
    const llm = new ScriptedLlmClient([{ content: [], stop_reason: "end_turn" }]);
    const result = await runAgentTurn(turnInput(llm));
    expect(result.outcome).toBe("completed");
    expect(result.newMessages.map((m) => m.role)).toEqual(["user"]);
    expect(result.text).toBe("");
  });
});

describe("runAgentTurn: stop_reason tool_use", () => {
  it("runs a single tool, feeds the result back, and loops to the answer", async () => {
    const llm = new ScriptedLlmClient([
      scriptedToolUse([{ id: "toolu_1", ...CHECK }], { thinking: "They want dermatology on Tuesday." }),
      scriptedText("Dr. Lee has an opening on Tuesday, October 13, 2026 at 2:30 PM ET."),
    ]);
    const executor = fakeExecutor({ check_availability: availability });
    const input = turnInput(llm, { executor });

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("completed");
    expect(executor.calls).toEqual([{ id: "toolu_1", name: "check_availability", input: CHECK.input }]);
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(toolResults(result.newMessages[2])).toEqual([
      {
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: JSON.stringify(EXAMPLES.CheckAvailabilityOutput),
      },
    ]);
    // The second call sees the assistant's tool_use and the result.
    expect(llm.requests[1]?.messages.slice(-2).map((m) => m.role)).toEqual(["assistant", "user"]);
    // One status chip, with the contract's label, before the answer streams.
    expect(input.events[0]).toEqual({
      type: "status",
      tool: "check_availability",
      label: TOOL_STATUS_LABELS.check_availability,
    });
    expect(input.events.slice(1).every((e) => e.type === "text_delta")).toBe(true);
    expect(result.trace.toolCalls).toEqual([
      expect.objectContaining({ toolUseId: "toolu_1", name: "check_availability", ok: true }),
    ]);
  });

  it("runs parallel tool calls concurrently and returns every result in ONE user message, in order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const finished: string[] = [];
    const slowThenFast = async (id: string, ms: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(ms);
      inFlight -= 1;
      finished.push(id);
      return { ok: true as const, output: { from: id } };
    };
    const executor = fakeExecutor({
      find_providers: (_input, _patient, call) => slowThenFast(call.id, 30),
      check_availability: (_input, _patient, call) => slowThenFast(call.id, 5),
    });
    const llm = new ScriptedLlmClient([
      scriptedToolUse([
        { id: "toolu_a", name: "find_providers", input: { specialty: "dermatology" } },
        { id: "toolu_b", ...CHECK },
      ]),
      scriptedText("Here's what I found."),
    ]);
    const input = turnInput(llm, { executor });

    const result = await runAgentTurn(input);

    expect(maxInFlight).toBe(2);
    expect(finished).toEqual(["toolu_b", "toolu_a"]); // b finished first...
    const userMessages = result.newMessages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2); // the patient's message + ONE tool-result message
    expect(toolResults(result.newMessages[2]).map((b) => b.tool_use_id)).toEqual(["toolu_a", "toolu_b"]); // ...but order is the model's
    expect(input.events.filter((e) => e.type === "status").map((e) => e.type === "status" && e.tool)).toEqual(
      ["find_providers", "check_availability"],
    );
    expect(result.trace.toolCalls.map((t) => t.toolUseId)).toEqual(["toolu_a", "toolu_b"]);
  });

  it("returns a failed tool as is_error with the ToolError body, and keeps going", async () => {
    const slotTaken = EXAMPLES.ToolError;
    const executor = fakeExecutor({ book_appointment: () => ({ ok: false, error: slotTaken }) });
    const llm = new ScriptedLlmClient([
      scriptedToolUse([{ id: "toolu_book", name: "book_appointment", input: EXAMPLES.BookAppointmentInput }]),
      scriptedText("Sorry, that time was just taken. Would you like the next opening?"),
    ]);

    const result = await runAgentTurn(turnInput(llm, { executor }));

    const [block] = toolResults(result.newMessages[2]);
    expect(block?.is_error).toBe(true);
    expect(ToolError.parse(JSON.parse(String(block?.content)))).toEqual(slotTaken);
    expect(result.outcome).toBe("completed");
    expect(result.trace.toolCalls[0]).toMatchObject({ ok: false, errorCode: "SLOT_UNAVAILABLE" });
  });

  it("turns an executor that throws into an INTERNAL is_error result; nothing throws out of the loop", async () => {
    const executor = fakeExecutor({
      get_my_appointments: () => {
        throw new Error("DynamoDB exploded: arn:aws:dynamodb:internal-details");
      },
    });
    const llm = new ScriptedLlmClient([
      scriptedToolUse([{ id: "toolu_x", name: "get_my_appointments", input: {} }]),
      scriptedText("Sorry, I couldn't load your appointments."),
    ]);

    const result = await runAgentTurn(turnInput(llm, { executor }));

    const [block] = toolResults(result.newMessages[2]);
    expect(block?.is_error).toBe(true);
    const body = ToolError.parse(JSON.parse(String(block?.content)));
    expect(body.error.code).toBe("INTERNAL");
    expect(String(block?.content)).not.toContain("DynamoDB"); // internals stay out of the model's context
    expect(result.trace.toolCalls[0]).toMatchObject({ ok: false, errorCode: "INTERNAL" });
  });

  it("answers a call to a tool it never offered with NOT_FOUND, without running or tracing it", async () => {
    const executor = fakeExecutor({ check_availability: availability });
    const llm = new ScriptedLlmClient([
      scriptedToolUse([
        { id: "toolu_bad", name: "delete_all_appointments", input: {} },
        { id: "toolu_ok", ...CHECK },
      ]),
      scriptedText("Here are the openings."),
    ]);
    const input = turnInput(llm, { executor });

    const result = await runAgentTurn(input);

    expect(executor.calls.map((c) => c.id)).toEqual(["toolu_ok"]);
    const [bad, ok] = toolResults(result.newMessages[2]);
    expect(bad).toMatchObject({ tool_use_id: "toolu_bad", is_error: true });
    expect(ToolError.parse(JSON.parse(String(bad?.content))).error.code).toBe("NOT_FOUND");
    expect(ok?.is_error).toBeUndefined();
    expect(input.events.filter((e) => e.type === "status")).toHaveLength(1);
    expect(result.trace.toolCalls.map((t) => t.toolUseId)).toEqual(["toolu_ok"]);
    TurnTrace.parse(result.trace);
  });

  it("enforces maxToolCallsPerTurn: calls beyond it get NOT_ALLOWED instead of running", async () => {
    const executor = fakeExecutor({ check_availability: availability });
    const llm = new ScriptedLlmClient([
      scriptedToolUse([
        { id: "toolu_1", ...CHECK },
        { id: "toolu_2", ...CHECK },
      ]),
      scriptedText("Here's the first set."),
    ]);

    const result = await runAgentTurn(turnInput(llm, { executor, limits: { maxToolCallsPerTurn: 1 } }));

    expect(executor.calls.map((c) => c.id)).toEqual(["toolu_1"]);
    const [, second] = toolResults(result.newMessages[2]);
    expect(ToolError.parse(JSON.parse(String(second?.content))).error.code).toBe("NOT_ALLOWED");
    expect(result.trace.toolCalls.map((t) => [t.toolUseId, t.ok, t.errorCode])).toEqual([
      ["toolu_1", true, undefined],
      ["toolu_2", false, "NOT_ALLOWED"],
    ]);
  });

  it("separates a text preamble from the answer when streaming", async () => {
    const llm = new ScriptedLlmClient([
      scriptedToolUse([CHECK], { text: "Let me check." }),
      scriptedText("Dr. Lee is free Tuesday at 2:30 PM ET."),
    ]);
    const input = turnInput(llm);

    const result = await runAgentTurn(input);

    const expected = `Let me check.${TEXT_BLOCK_SEPARATOR}Dr. Lee is free Tuesday at 2:30 PM ET.`;
    expect(textDeltas(input.events)).toBe(expected);
    expect(result.text).toBe(expected);
  });
});

describe("runAgentTurn: stop_reason max_tokens", () => {
  it("retries once with the larger budget and discards the truncated response", async () => {
    const llm = new ScriptedLlmClient([
      scriptedMaxTokens({ partialText: "Dr. Lee has" }),
      scriptedText("Done."),
    ]);

    const result = await runAgentTurn(turnInput(llm));

    expect(llm.requests.map((r) => r.max_tokens)).toEqual([sonnet.maxTokens, sonnet.retryMaxTokens]);
    // The retry is the same conversation: the truncated reply was never appended.
    expect(llm.requests[1]?.messages).toEqual(llm.requests[0]?.messages);
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.text).toBe("Done.");
    expect(result.outcome).toBe("completed");
    expect(result.trace.llmCalls.map((c) => c.stopReason)).toEqual(["max_tokens", "end_turn"]);
  });

  it("never runs a tool whose input was cut off at max_tokens", async () => {
    const executor = fakeExecutor({ book_appointment: () => ({ ok: true, output: {} }) });
    const truncated = scriptedToolUse([
      { id: "toolu_cut", name: "book_appointment", input: { slot_id: EXAMPLES.SlotId } },
    ]);
    const llm = new ScriptedLlmClient([
      { ...truncated, stop_reason: "max_tokens" },
      scriptedText("Which reason?"),
    ]);

    const result = await runAgentTurn(turnInput(llm, { executor }));

    expect(executor.calls).toHaveLength(0);
    expect(JSON.stringify(result.newMessages)).not.toContain("toolu_cut");
  });

  it("fails gracefully when the retry is cut off too", async () => {
    const llm = new ScriptedLlmClient([scriptedMaxTokens(), scriptedMaxTokens(), scriptedText("unused")]);
    const input = turnInput(llm);

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("max_tokens");
    expect(llm.requests).toHaveLength(2);
    expect(llm.remaining).toBe(1);
    expect(result.newMessages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: FALLBACK_MESSAGES.maxTokens }],
    });
    expect(textDeltas(input.events)).toBe(FALLBACK_MESSAGES.maxTokens);
  });

  it("fails gracefully (no retry) when the context window is exhausted", async () => {
    const llm = new ScriptedLlmClient([{ content: [], stop_reason: "model_context_window_exceeded" }]);
    const result = await runAgentTurn(turnInput(llm));
    expect(result.outcome).toBe("max_tokens");
    expect(llm.requests).toHaveLength(1);
    expect(result.text).toBe(FALLBACK_MESSAGES.maxTokens);
  });
});

describe("runAgentTurn: stop_reason refusal", () => {
  it("retries once on the fallback profile and stays on it for the rest of the turn", async () => {
    const llm = new ScriptedLlmClient([
      scriptedRefusal(),
      scriptedToolUse([CHECK]),
      scriptedText("Dr. Lee has an opening Tuesday."),
    ]);

    const result = await runAgentTurn(turnInput(llm));

    expect(result.outcome).toBe("completed");
    expect(llm.requests.map((r) => r.model)).toEqual([sonnet.modelId, haiku.modelId, haiku.modelId]);
    // The fallback request uses the fallback's own params: Haiku 4.5 takes no effort and no thinking.
    expect(llm.requests[0]).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(llm.requests[1]).not.toHaveProperty("thinking");
    expect(llm.requests[1]).not.toHaveProperty("output_config");
    expect(llm.requests[1]?.max_tokens).toBe(haiku.maxTokens);
    // The refused response was discarded, not stored.
    expect(llm.requests[1]?.messages).toEqual(llm.requests[0]?.messages);
    // The trace keeps the requested profile; each call records the model that ran it.
    expect(result.trace.modelProfile).toBe("sonnet-4.6");
    expect(result.trace.llmCalls.map((c) => [c.modelId, c.stopReason])).toEqual([
      [sonnet.modelId, "refusal"],
      [haiku.modelId, "tool_use"],
      [haiku.modelId, "end_turn"],
    ]);
  });

  it("gives a safe message with the front desk number when the fallback refuses too", async () => {
    const llm = new ScriptedLlmClient([scriptedRefusal({ category: "general_harms" }), scriptedRefusal()]);
    const input = turnInput(llm);

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("refusal");
    expect(llm.requests).toHaveLength(2);
    expect(result.text).toBe(FALLBACK_MESSAGES.refusal);
    expect(result.text).toContain("1-800-555-0199");
    expect(result.text).toContain("911");
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(textDeltas(input.events)).toBe(FALLBACK_MESSAGES.refusal);
  });

  it("separates partial text from a mid-stream refusal from what follows", async () => {
    const llm = new ScriptedLlmClient([
      scriptedRefusal({ partialText: "Sure, " }),
      scriptedText("Happy to help."),
    ]);
    const input = turnInput(llm);

    const result = await runAgentTurn(input);

    expect(result.text).toBe("Happy to help."); // the refused partial isn't stored
    expect(textDeltas(input.events)).toBe(`Sure, ${TEXT_BLOCK_SEPARATOR}Happy to help.`);
  });
});

describe("runAgentTurn: iteration cap", () => {
  it("stops after maxIterations model calls with an apology and an escalation offer; never spins", async () => {
    const executor = fakeExecutor({ check_availability: availability });
    const llm = new ScriptedLlmClient(Array.from({ length: 20 }, () => scriptedToolUse([CHECK])));
    const input = turnInput(llm, { executor });

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("iteration_limit");
    expect(llm.requests).toHaveLength(8);
    expect(llm.remaining).toBe(12);
    // The 8th call's tools are answered without running: no call is left to tell the patient the result.
    expect(executor.calls).toHaveLength(7);
    const lastResults = toolResults(result.newMessages.at(-2));
    expect(lastResults).toHaveLength(1);
    expect(lastResults[0]?.is_error).toBe(true);
    expect(ToolError.parse(JSON.parse(String(lastResults[0]?.content))).error.code).toBe("NOT_ALLOWED");
    expect(result.newMessages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: FALLBACK_MESSAGES.iterationLimit }],
    });
    expect(result.text).toContain("front desk");
    expect(result.trace.iterations).toBe(8);
    expect(result.trace.toolCalls).toHaveLength(8);
    expect(result.trace.toolCalls.at(-1)).toMatchObject({
      ok: false,
      errorCode: "NOT_ALLOWED",
      durationMs: 0,
    });
  });

  it("counts retries as iterations, so a retry can't push the turn past the cap", async () => {
    const llm = new ScriptedLlmClient([
      scriptedToolUse([CHECK]),
      scriptedMaxTokens(),
      scriptedText("unused"),
    ]);

    const result = await runAgentTurn(turnInput(llm, { limits: { maxIterations: 2 } }));

    expect(llm.requests).toHaveLength(2);
    expect(result.outcome).toBe("iteration_limit");
    expect(result.newMessages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: FALLBACK_MESSAGES.iterationLimit }],
    });
  });
});

describe("runAgentTurn: model call failures", () => {
  it("returns outcome error (never throws) with a valid history when the first call fails", async () => {
    const throttled = new Error("429 Too many requests");
    const llm = new ScriptedLlmClient([{ error: throttled }]);
    const input = turnInput(llm);

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("error");
    expect(result.error).toBe(throttled);
    expect(result.newMessages.map((m) => m.role)).toEqual(["user"]);
    expect(input.events).toEqual([]); // the handler owns the terminal `error` event
    expect(TurnTrace.parse(result.trace).llmCalls).toEqual([
      expect.objectContaining({ stopReason: "error", usage: expect.objectContaining({ inputTokens: 0 }) }),
    ]);
  });

  it("keeps completed tool rounds when a later call fails", async () => {
    const llm = new ScriptedLlmClient([scriptedToolUse([CHECK]), { error: new Error("socket hang up") }]);
    const result = await runAgentTurn(turnInput(llm));
    expect(result.outcome).toBe("error");
    expect(result.newMessages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("doesn't start tools when the signal aborted during the call, and stores nothing dangling", async () => {
    const controller = new AbortController();
    const executor = fakeExecutor({ book_appointment: () => ({ ok: true, output: {} }) });
    const llm = new ScriptedLlmClient([
      () => {
        controller.abort(new Error("client went away"));
        return scriptedToolUse([{ name: "book_appointment", input: EXAMPLES.BookAppointmentInput }]);
      },
    ]);

    const result = await runAgentTurn(turnInput(llm, { executor, signal: controller.signal }));

    expect(result.outcome).toBe("error");
    expect(executor.calls).toHaveLength(0);
    expect(result.newMessages.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("runAgentTurn: trace", () => {
  it("validates against TurnTrace, with per-call timings, TTFT, stop reasons, and cache usage summed", async () => {
    let now = 1_000;
    const monotonicNow = () => (now += 7); // every reading advances 7 ms
    const executor = fakeExecutor({
      check_availability: availability,
      book_appointment: () => ({ ok: false, error: EXAMPLES.ToolError }),
    });
    const llm = new ScriptedLlmClient([
      scriptedRefusal(),
      scriptedToolUse([CHECK], {
        usage: {
          input_tokens: 50,
          output_tokens: 30,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 200,
        },
      }),
      scriptedMaxTokens(),
      scriptedToolUse([{ name: "book_appointment", input: EXAMPLES.BookAppointmentInput }]),
      scriptedText("That slot was just taken.", {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2400,
          cache_creation_input_tokens: 0,
        },
      }),
    ]);

    const result = await runAgentTurn(turnInput(llm, { executor, monotonicNow }));
    const trace = TurnTrace.parse(result.trace);

    expect(trace).toMatchObject({
      turnId: EXAMPLES.TurnId,
      conversationId: EXAMPLES.ConversationId,
      modelProfile: "sonnet-4.6",
      modelId: sonnet.modelId,
      promptVersion: SYSTEM.version,
      startedAt: "2026-10-05T13:00:00.000Z",
      iterations: 5,
      outcome: "completed",
    });
    expect(trace.llmCalls.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    expect(trace.llmCalls.map((c) => c.stopReason)).toEqual([
      "refusal",
      "tool_use",
      "max_tokens",
      "tool_use",
      "end_turn",
    ]);
    for (const call of trace.llmCalls) expect(call.durationMs).toBeGreaterThan(0);
    // A refusal before any output streams no block, so it has no TTFT; every other call does.
    expect(trace.llmCalls[0]?.ttftMs).toBeUndefined();
    for (const call of trace.llmCalls.slice(1)) {
      expect(call.ttftMs).toBeGreaterThan(0);
      expect(call.ttftMs).toBeLessThanOrEqual(call.durationMs);
    }
    expect(trace.toolCalls.map((t) => [t.name, t.ok, t.errorCode])).toEqual([
      ["check_availability", true, undefined],
      ["book_appointment", false, "SLOT_UNAVAILABLE"],
    ]);
    expect(trace.toolCalls.every((t) => t.durationMs > 0)).toBe(true);
    // Usage sums every call, discarded ones included (they're billed). Scripted defaults: 100 in / 20 out.
    expect(result.usage).toEqual({
      inputTokens: 100 + 50 + 100 + 100 + 10,
      outputTokens: 20 + 30 + 20 + 20 + 5,
      cacheReadTokens: 2000 + 2400,
      cacheWriteTokens: 200,
    });
    expect(trace.usage).toEqual(result.usage);
    expect(trace.durationMs).toBeGreaterThanOrEqual(trace.llmCalls.reduce((sum, c) => sum + c.durationMs, 0));
  });

  it("emits only contract-valid status and text_delta events, never done or error", async () => {
    const llm = new ScriptedLlmClient([
      scriptedToolUse([CHECK], { text: "One moment." }),
      scriptedText("Found it."),
    ]);
    const input = turnInput(llm);
    await runAgentTurn(input);
    for (const event of input.events) ChatStreamEvent.parse(event);
    expect(new Set(input.events.map((e) => e.type))).toEqual(new Set(["status", "text_delta"]));
  });
});

describe("runAgentTurn: prompt caching", () => {
  it("puts the breakpoint on the stable system block (after tools), the dynamic block after it, and a rolling one on the last message", async () => {
    const llm = new ScriptedLlmClient([scriptedToolUse([CHECK]), scriptedText("Found it.")]);
    const history: Anthropic.MessageParam[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello! How can I help?" }] },
    ];

    const result = await runAgentTurn(turnInput(llm, { history }));

    for (const request of llm.requests) {
      expect(request.system).toEqual([
        { type: "text", text: SYSTEM.stable, cache_control: { type: "ephemeral" } },
        { type: "text", text: SYSTEM.dynamic },
      ]);
      // Tools render before system, so the system breakpoint caches them too. They're sent exactly as
      // defined (stable bytes, stable order) and carry no marker of their own.
      expect(request.tools).toEqual(fakeExecutor().definitions);
      expect(valuesForKey(request.tools, "cache_control")).toEqual([]);
      // Exactly two breakpoints: the stable system block, and the last block of the final user message.
      expect(valuesForKey(request, "cache_control")).toHaveLength(2);
      const last = contentOf(request.messages.at(-1)).at(-1);
      expect(last).toHaveProperty("cache_control", { type: "ephemeral" });
      expect(valuesForKey(request.messages.slice(0, -1), "cache_control")).toEqual([]);
    }
    // First call: the breakpoint is on the patient's message; second: on the tool results.
    expect(contentOf(llm.requests[0]?.messages.at(-1)).at(-1)?.type).toBe("text");
    expect(contentOf(llm.requests[1]?.messages.at(-1)).at(-1)?.type).toBe("tool_result");
    // Markers exist only on request copies, never in stored messages.
    expect(valuesForKey(result.newMessages, "cache_control")).toEqual([]);
  });

  it("sends one system block when there's no dynamic context", async () => {
    const llm = new ScriptedLlmClient([scriptedText("Hi!")]);
    await runAgentTurn(turnInput(llm, { system: { version: "v", stable: "Stable only." } }));
    expect(llm.requests[0]?.system).toEqual([
      { type: "text", text: "Stable only.", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("runAgentTurn: append-only history", () => {
  it("never mutates its inputs, and every request starts with the history unchanged", async () => {
    const history: Anthropic.MessageParam[] = deepFreeze([
      { role: "user", content: "I need a dermatologist." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Earlier reasoning.", signature: "sig_prev" },
          { type: "text", text: "Sure, which day works?" },
        ],
      },
    ]);
    const snapshot = structuredClone(history);
    const llm = new ScriptedLlmClient([scriptedToolUse([CHECK]), scriptedText("Tuesday works.")]);
    const executor = fakeExecutor({
      check_availability: (input) => {
        // A misbehaving executor that mutates its input can't reach stored messages.
        (input as Record<string, unknown>).specialty = "cardiology";
        return availability();
      },
    });

    const result = await runAgentTurn(turnInput(llm, { history, executor }));

    expect(history).toEqual(snapshot);
    for (const request of llm.requests) expect(request.messages.slice(0, history.length)).toEqual(snapshot);
    const toolUse = contentOf(result.newMessages[1]).find((b) => b.type === "tool_use");
    expect(toolUse).toMatchObject({ input: CHECK.input });
  });

  it("passes assistant content back unchanged, thinking blocks and signatures included", async () => {
    const first = scriptedToolUse([{ id: "toolu_t", ...CHECK }], { thinking: "Dermatology, Tuesday PM." });
    const llm = new ScriptedLlmClient([first, scriptedText("Found one.")]);

    const result = await runAgentTurn(turnInput(llm));

    expect(llm.requests[1]?.messages[1]).toEqual({ role: "assistant", content: first.content });
    expect(result.newMessages[1]).toEqual({ role: "assistant", content: first.content });
    expect(contentOf(result.newMessages[1])[0]).toEqual({
      type: "thinking",
      thinking: "Dermatology, Tuesday PM.",
      signature: expect.any(String),
    });
  });

  it("continues a conversation across turns by appending (the next turn's prefix is this turn's messages)", async () => {
    const llm = new ScriptedLlmClient([
      scriptedToolUse([CHECK]),
      scriptedText("Tuesday at 2:30?"),
      scriptedText("Booked!"),
    ]);
    const turn1 = await runAgentTurn(turnInput(llm));
    const history = [...turn1.newMessages];

    await runAgentTurn(turnInput(llm, { history, userMessage: "Yes please" }));

    const turn2Request = llm.requests[2];
    expect(turn2Request?.messages.slice(0, history.length)).toEqual(history);
    expect(contentOf(turn2Request?.messages.at(-1))[0]).toMatchObject({ type: "text", text: "Yes please" });
  });
});

describe("runAgentTurn: identity (CLAUDE.md rule 1)", () => {
  it("never puts a patient ID in anything it sends to the model or passes to tools", async () => {
    const executor = fakeExecutor({
      get_my_appointments: (_input, boundPatientId) => {
        expect(boundPatientId).toBe(PATIENT_ID); // the executor knows the patient...
        return { ok: true, output: EXAMPLES.GetMyAppointmentsOutput };
      },
      check_availability: availability,
      book_appointment: () => ({ ok: true, output: EXAMPLES.BookAppointmentOutput }),
    });
    const llm = new ScriptedLlmClient([
      scriptedToolUse([{ name: "get_my_appointments", input: {} }, CHECK]),
      scriptedToolUse([{ name: "book_appointment", input: EXAMPLES.BookAppointmentInput }]),
      scriptedText("You're booked."),
    ]);

    await runAgentTurn(turnInput(llm, { executor }));

    // ...but nothing the loop builds does.
    const sent = JSON.stringify(llm.requests);
    expect(sent).not.toContain(PATIENT_ID);
    expect(allKeys(llm.requests).filter((k) => /^patient_?id$/i.test(k))).toEqual([]);
    expect(allKeys(executor.calls).filter((k) => /patient/i.test(k))).toEqual([]);
    expect(executor.calls.map((c) => Object.keys(c).sort())).toEqual([
      ["id", "input", "name"],
      ["id", "input", "name"],
      ["id", "input", "name"],
    ]);
  });
});
