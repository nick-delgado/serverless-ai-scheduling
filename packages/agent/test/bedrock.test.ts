/**
 * BedrockLlmClient over the real SDK with a fake `fetch`: no network, no AWS credentials (`skipAuth`).
 * The Bedrock adapter passes a `text/event-stream` response through untouched, so SSE fixtures exercise
 * the SDK's own request rewriting, stream parsing, and message accumulation.
 */
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { EXAMPLES } from "@sched/contracts/testing";
import { describe, expect, it } from "vitest";

import { BedrockLlmClient, type LlmRequest, MODEL_PROFILES, runAgentTurn, ScriptedLlmClient } from "../src";
import { fakeExecutor, SYSTEM, turnInput } from "./helpers";

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

type SseEvent = { type: string } & Record<string, unknown>;

function sse(events: SseEvent[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function messageStart(model: string): SseEvent {
  return {
    type: "message_start",
    message: {
      id: "msg_bdrk_01",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      container: null,
      usage: {
        input_tokens: 40,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2142,
      },
    },
  };
}

const textStream = (text: string[]): SseEvent[] => [
  messageStart("claude-sonnet-4-6"),
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Greet them." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  ...text.map((t) => ({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: t } })),
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 25 },
  },
  { type: "message_stop" },
];

const toolUseStream = (id: string, input: unknown): SseEvent[] => {
  const json = JSON.stringify(input);
  const half = Math.floor(json.length / 2);
  return [
    messageStart("claude-sonnet-4-6"),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name: "check_availability", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: json.slice(0, half) },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: json.slice(half) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 60 },
    },
    { type: "message_stop" },
  ];
};

/** A Bedrock client whose `fetch` replays canned responses and records each request. */
function fakeBedrock(responses: Response[]): { llm: BedrockLlmClient; captured: Captured[] } {
  const captured: Captured[] = [];
  const client = new AnthropicBedrock({
    awsRegion: "us-east-1",
    skipAuth: true,
    maxRetries: 0,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      captured.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const response = responses.shift();
      if (!response) throw new Error("fakeBedrock: no response left");
      return response;
    },
  });
  return { llm: new BedrockLlmClient({ client }), captured };
}

const streamResponse = (events: SseEvent[]) =>
  new Response(sse(events), { status: 200, headers: { "content-type": "text/event-stream" } });

const request = (model: string): LlmRequest => ({
  model,
  max_tokens: 8000,
  thinking: { type: "adaptive" },
  output_config: { effort: "medium" },
  system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
});

describe("BedrockLlmClient", () => {
  it("streams to invoke-with-response-stream and reports blocks, text deltas, and the final message", async () => {
    const { llm, captured } = fakeBedrock([streamResponse(textStream(["Hello", " Maria!"]))]);
    const blocks: string[] = [];
    const deltas: string[] = [];

    const message = await llm.streamMessage(request("us.anthropic.claude-sonnet-4-6"), {
      onContentBlockStart: (b) => blocks.push(b.type),
      onTextDelta: (t) => deltas.push(t),
    });

    expect(new URL(captured[0]?.url ?? "").pathname).toBe(
      "/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream",
    );
    // Bedrock's wire shape: the model moves to the path, anthropic_version is added, params pass through.
    expect(captured[0]?.body).toMatchObject({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
    });
    expect(captured[0]?.body).not.toHaveProperty("model");
    expect(captured[0]?.body).not.toHaveProperty("stream");

    expect(blocks).toEqual(["thinking", "text"]);
    expect(deltas).toEqual(["Hello", " Maria!"]);
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Greet them.", signature: "sig_abc" },
      { type: "text", text: "Hello Maria!" },
    ]);
    expect(message.usage).toMatchObject({
      input_tokens: 40,
      output_tokens: 25,
      cache_read_input_tokens: 2142,
    });
  });

  it("puts versioned inference-profile IDs in the path as-is", async () => {
    const { llm, captured } = fakeBedrock([streamResponse(textStream(["ok"]))]);
    await llm.streamMessage(request(MODEL_PROFILES["haiku-4.5"].modelId));
    expect(new URL(captured[0]?.url ?? "").pathname).toBe(
      "/model/us.anthropic.claude-haiku-4-5-20251001-v1:0/invoke-with-response-stream",
    );
  });

  it("rejects with the SDK's typed error on an API error", async () => {
    const { llm } = fakeBedrock([
      new Response(JSON.stringify({ message: "The provided model identifier is invalid." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ]);
    await expect(llm.streamMessage(request("us.anthropic.nope"))).rejects.toBeInstanceOf(
      Anthropic.BadRequestError,
    );
  });

  it("drives a full tool-use turn through runAgentTurn", async () => {
    const { llm, captured } = fakeBedrock([
      streamResponse(toolUseStream("toolu_bdrk_1", EXAMPLES.CheckAvailabilityInput)),
      streamResponse(textStream(["Dr. Lee is free ", "Tuesday at 2:30 PM ET."])),
    ]);
    const executor = fakeExecutor({
      check_availability: () => ({ ok: true, output: EXAMPLES.CheckAvailabilityOutput }),
    });
    const input = turnInput(new ScriptedLlmClient(), { llm, executor, system: SYSTEM });

    const result = await runAgentTurn(input);

    expect(result.outcome).toBe("completed");
    expect(executor.calls).toEqual([
      { id: "toolu_bdrk_1", name: "check_availability", input: EXAMPLES.CheckAvailabilityInput },
    ]);
    expect(result.text).toBe("Dr. Lee is free Tuesday at 2:30 PM ET.");
    expect(result.trace.usage.cacheReadTokens).toBe(2142 * 2);
    expect(captured).toHaveLength(2);
    const second = captured[1]?.body as { messages: Array<{ role: string; content: unknown[] }> };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});
