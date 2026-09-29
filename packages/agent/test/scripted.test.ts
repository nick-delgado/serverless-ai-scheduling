import { describe, expect, it } from "vitest";

import { type LlmRequest, ScriptedLlmClient, scriptedText, scriptedToolUse } from "../src";

const request = (text: string): LlmRequest => ({
  model: "us.anthropic.claude-sonnet-4-6",
  max_tokens: 100,
  messages: [{ role: "user", content: text }],
});

describe("ScriptedLlmClient", () => {
  it("replays responses in order and streams text as fixed-size deltas", async () => {
    const llm = new ScriptedLlmClient([scriptedText("Hello there, Maria!", { thinking: "greet" })], {
      chunkSize: 5,
    });
    const blocks: string[] = [];
    const deltas: string[] = [];

    const message = await llm.streamMessage(request("hi"), {
      onContentBlockStart: (b) => blocks.push(b.type),
      onTextDelta: (t) => deltas.push(t),
    });

    expect(blocks).toEqual(["thinking", "text"]);
    expect(deltas).toEqual(["Hello", " ther", "e, Ma", "ria!"]);
    expect(message).toMatchObject({
      role: "assistant",
      model: "us.anthropic.claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20 },
    });
    expect(llm.remaining).toBe(0);
  });

  it("records a deep copy of each request", async () => {
    const llm = new ScriptedLlmClient([scriptedText("a")]);
    const req = request("original");
    await llm.streamMessage(req);
    req.messages.push({ role: "assistant", content: "mutated later" });
    expect(llm.requests[0]?.messages).toHaveLength(1);
  });

  it("returns a fresh copy of scripted content each time", async () => {
    const response = scriptedToolUse([
      { id: "toolu_1", name: "find_providers", input: { name_query: "Lee" } },
    ]);
    const llm = new ScriptedLlmClient([response, response]);
    const first = await llm.streamMessage(request("a"));
    first.content.length = 0;
    const second = await llm.streamMessage(request("b"));
    expect(second.content).toHaveLength(1);
  });

  it("throws scripted errors and fails loudly when the script runs out", async () => {
    const boom = new Error("throttled");
    const llm = new ScriptedLlmClient([{ error: boom }]);
    await expect(llm.streamMessage(request("a"))).rejects.toBe(boom);
    await expect(llm.streamMessage(request("b"))).rejects.toThrow(/no scripted response left for call #1/);
  });

  it("builds a response from the request when the step is a function", async () => {
    const llm = new ScriptedLlmClient().enqueue((req) => scriptedText(`echo ${req.max_tokens}`));
    const message = await llm.streamMessage(request("a"));
    expect(message.content).toEqual([{ type: "text", text: "echo 100", citations: null }]);
  });

  it("honors an aborted signal", async () => {
    const llm = new ScriptedLlmClient([scriptedText("never")]);
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(llm.streamMessage(request("a"), {}, { signal: controller.signal })).rejects.toThrow("gone");
  });
});
