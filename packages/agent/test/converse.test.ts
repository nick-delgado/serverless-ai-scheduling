import type { ConverseStreamCommand, ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { toolDefinitionsForModel } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { CACHE_POINT, ConverseLlmClient, type LlmRequest } from "../src";
import { InlineReasoningFilter, toConverseRequest, toLlmStopReason } from "../src/llm/converse";

const baseRequest = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  modelId: "us.anthropic.claude-sonnet-4-6",
  family: "anthropic.claude",
  system: [{ type: "text", text: "Stable." }, CACHE_POINT, { type: "text", text: "Today is Monday." }],
  tools: toolDefinitionsForModel().slice(0, 2),
  messages: [{ role: "user", content: [{ type: "text", text: "Hi" }, CACHE_POINT] }],
  maxTokens: 8000,
  modelFields: { thinking: { type: "adaptive" } },
  ...overrides,
});

/** A sender that replays `events` as the ConverseStream event stream and records what it was sent. */
function fakeSender(events: ConverseStreamOutput[]) {
  const sent: { input: ConverseStreamCommand["input"]; abortSignal?: AbortSignal }[] = [];
  return {
    sent,
    async send(command: ConverseStreamCommand, options?: { abortSignal?: AbortSignal }) {
      sent.push({ input: command.input, abortSignal: options?.abortSignal });
      return {
        stream: (async function* () {
          for (const e of events) {
            await Promise.resolve();
            yield e;
          }
        })(),
      };
    },
  };
}

const textDelta = (i: number, text: string): ConverseStreamOutput => ({
  contentBlockDelta: { contentBlockIndex: i, delta: { text } },
});
const stop = (stopReason: string): ConverseStreamOutput =>
  ({ messageStop: { stopReason } }) as ConverseStreamOutput;
const usage = (u: Record<string, number>): ConverseStreamOutput =>
  ({ metadata: { usage: u, metrics: { latencyMs: 1 } } }) as unknown as ConverseStreamOutput;

async function run(events: ConverseStreamOutput[], request = baseRequest()) {
  const sender = fakeSender(events);
  const client = new ConverseLlmClient({ client: sender });
  const starts: string[] = [];
  const deltas: string[] = [];
  const response = await client.streamMessage(request, {
    onContentBlockStart: (b) => starts.push(b.type),
    onTextDelta: (t) => deltas.push(t),
  });
  return { response, starts, deltas, sent: sender.sent };
}

describe("toConverseRequest", () => {
  it("maps system, tools, messages, cache points, and model fields to Converse shapes", () => {
    const input = toConverseRequest(
      baseRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "Openings Tuesday?" }] },
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                family: "anthropic.claude",
                modelId: "m",
                text: "Think.",
                signature: "sig",
              },
              {
                type: "tool_use",
                id: "tooluse_1",
                name: "check_availability",
                input: { specialty: "dermatology" },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "tooluse_1", content: '{"slots":[]}' },
              { type: "tool_result", toolUseId: "tooluse_2", content: '{"error":{}}', isError: true },
              CACHE_POINT,
            ],
          },
        ],
      }),
    );

    expect(input.system).toEqual([
      { text: "Stable." },
      { cachePoint: { type: "default" } },
      { text: "Today is Monday." },
    ]);
    expect(input.toolConfig?.tools?.[0]).toEqual({
      toolSpec: {
        name: "find_providers",
        description: toolDefinitionsForModel()[0]?.description,
        inputSchema: { json: toolDefinitionsForModel()[0]?.inputSchema },
      },
    });
    expect(input.messages?.[1]?.content).toEqual([
      { reasoningContent: { reasoningText: { text: "Think.", signature: "sig" } } },
      {
        toolUse: { toolUseId: "tooluse_1", name: "check_availability", input: { specialty: "dermatology" } },
      },
    ]);
    expect(input.messages?.[2]?.content).toEqual([
      { toolResult: { toolUseId: "tooluse_1", content: [{ text: '{"slots":[]}' }] } },
      { toolResult: { toolUseId: "tooluse_2", content: [{ text: '{"error":{}}' }], status: "error" } },
      { cachePoint: { type: "default" } },
    ]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 8000 });
    expect(input.additionalModelRequestFields).toEqual({ thinking: { type: "adaptive" } });
  });

  it("omits empty model fields, and round-trips redacted reasoning as bytes", () => {
    const input = toConverseRequest(
      baseRequest({
        modelFields: {},
        messages: [
          { role: "user", content: [{ type: "text", text: "Hi" }] },
          {
            role: "assistant",
            content: [
              { type: "reasoning", family: "anthropic.claude", modelId: "m", redactedContent: "AQID" },
              { type: "text", text: "Hello" },
            ],
          },
        ],
      }),
    );
    expect(input).not.toHaveProperty("additionalModelRequestFields");
    const redacted = input.messages?.[1]?.content?.[0]?.reasoningContent?.redactedContent;
    expect(Array.from(redacted ?? [])).toEqual([1, 2, 3]);
  });

  it("merges adjacent same-role messages (Converse requires alternating roles)", () => {
    const input = toConverseRequest(
      baseRequest({
        messages: [
          { role: "user", content: [{ type: "text", text: "First" }] },
          { role: "user", content: [{ type: "text", text: "Second" }] },
        ],
      }),
    );
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "First" }, { text: "Second" }] }]);
  });
});

describe("ConverseLlmClient", () => {
  it("streams text, assembles reasoning with its signature, and parses tool input (Claude's event shape)", async () => {
    const { response, starts, deltas, sent } = await run([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "Check " } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "dermatology." } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-abc" } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      textDelta(1, "Let me "),
      textDelta(1, "check."),
      { contentBlockStop: { contentBlockIndex: 1 } },
      {
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: "tooluse_1", name: "check_availability" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"specialty":' } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '"dermatology"}' } } } },
      { contentBlockStop: { contentBlockIndex: 2 } },
      stop("tool_use"),
      usage({
        inputTokens: 649,
        outputTokens: 121,
        totalTokens: 3000,
        cacheReadInputTokens: 2000,
        cacheWriteInputTokens: 230,
      }),
    ]);

    expect(sent[0]?.input.modelId).toBe("us.anthropic.claude-sonnet-4-6");
    expect(starts).toEqual(["reasoning", "text", "tool_use"]);
    expect(deltas).toEqual(["Let me ", "check."]);
    expect(response).toEqual({
      content: [
        {
          type: "reasoning",
          family: "anthropic.claude",
          modelId: "us.anthropic.claude-sonnet-4-6",
          text: "Check dermatology.",
          signature: "sig-abc",
        },
        { type: "text", text: "Let me check." },
        {
          type: "tool_use",
          id: "tooluse_1",
          name: "check_availability",
          input: { specialty: "dermatology" },
        },
      ],
      stopReason: "tool_use",
      providerStopReason: "tool_use",
      usage: { inputTokens: 649, outputTokens: 121, cacheReadTokens: 2000, cacheWriteTokens: 230 },
    });
  });

  it("drops gpt-oss's empty text block and keeps unsigned reasoning", async () => {
    const { response } = await run(
      [
        textDelta(0, ""),
        {
          contentBlockDelta: {
            contentBlockIndex: 1,
            delta: { reasoningContent: { text: "Call the tool." } },
          },
        },
        {
          contentBlockStart: {
            contentBlockIndex: 2,
            start: { toolUse: { toolUseId: "t", name: "get_my_appointments" } },
          },
        },
        stop("tool_use"),
      ],
      baseRequest({ family: "openai.gpt-oss", modelId: "openai.gpt-oss-120b-1:0" }),
    );

    expect(response.content).toEqual([
      {
        type: "reasoning",
        family: "openai.gpt-oss",
        modelId: "openai.gpt-oss-120b-1:0",
        text: "Call the tool.",
      },
      { type: "tool_use", id: "t", name: "get_my_appointments", input: {} },
    ]);
  });

  it("encodes redacted reasoning as base64", async () => {
    const { response } = await run([
      {
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } },
        },
      },
      textDelta(1, "Hi"),
      stop("end_turn"),
    ]);
    expect(response.content[0]).toMatchObject({ type: "reasoning", redactedContent: "AQID" });
  });

  it("turns tool input that isn't JSON into malformed_output", async () => {
    const { response } = await run([
      {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { toolUseId: "t", name: "book_appointment" } },
        },
      },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"slot_id": "slot_' } } } },
      stop("tool_use"),
    ]);
    expect(response.stopReason).toBe("malformed_output");
    expect(response.providerStopReason).toBe("tool_use");
  });

  it("hides a leading inline <thinking> section (Nova Pro), even split across deltas", async () => {
    const { response, deltas } = await run(
      [
        textDelta(0, "<thin"),
        textDelta(0, "king> I need to check "),
        textDelta(0, "availability. </thinking>\n"),
        { contentBlockStop: { contentBlockIndex: 0 } },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { toolUseId: "t", name: "check_availability" } },
          },
        },
        stop("tool_use"),
      ],
      baseRequest({
        family: "amazon.nova",
        modelId: "us.amazon.nova-pro-v1:0",
        inlineReasoningTag: "thinking",
      }),
    );
    expect(deltas).toEqual([]);
    expect(response.content).toEqual([
      {
        type: "reasoning",
        family: "amazon.nova",
        modelId: "us.amazon.nova-pro-v1:0",
        text: "I need to check availability.",
      },
      { type: "tool_use", id: "t", name: "check_availability", input: {} },
    ]);
  });

  it("rethrows an in-stream exception event", async () => {
    const throttled = Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
    await expect(
      run([textDelta(0, "Hi"), { throttlingException: throttled } as ConverseStreamOutput]),
    ).rejects.toBe(throttled);
  });

  it("passes the abort signal to the SDK", async () => {
    const sender = fakeSender([stop("end_turn")]);
    const controller = new AbortController();
    await new ConverseLlmClient({ client: sender }).streamMessage(
      baseRequest(),
      {},
      { signal: controller.signal },
    );
    expect(sender.sent[0]?.abortSignal).toBe(controller.signal);
  });
});

describe("toLlmStopReason", () => {
  it.each([
    ["end_turn", "end_turn"],
    ["tool_use", "tool_use"],
    ["max_tokens", "max_tokens"],
    ["stop_sequence", "stop_sequence"],
    ["guardrail_intervened", "refusal"],
    ["content_filtered", "refusal"],
    ["model_context_window_exceeded", "context_window_exceeded"],
    ["malformed_tool_use", "malformed_output"],
    ["malformed_model_output", "malformed_output"],
    ["something_new", "end_turn"],
    [undefined, "end_turn"],
  ])("%s → %s", (raw, neutral) => {
    expect(toLlmStopReason(raw)).toBe(neutral);
  });
});

describe("InlineReasoningFilter", () => {
  const feed = (chunks: string[]) => {
    const filter = new InlineReasoningFilter("thinking");
    const shown = chunks.map((c) => filter.push(c)).join("") + filter.end();
    return { shown, reasoning: filter.reasoning };
  };

  it("streams ordinary text untouched once it can't be the tag", () => {
    expect(feed(["Dr. Lee ", "is free."])).toEqual({ shown: "Dr. Lee is free.", reasoning: "" });
    expect(feed(["<b>", "bold"])).toEqual({ shown: "<b>bold", reasoning: "" });
  });

  it("splits a leading tagged section from the answer that follows", () => {
    expect(feed(["<thinking>plan</thinking>", "  Tuesday works."])).toEqual({
      shown: "Tuesday works.",
      reasoning: "plan",
    });
  });

  it("treats an unclosed tag as all reasoning, and a lone prefix as text", () => {
    expect(feed(["<thinking>never closed"])).toEqual({ shown: "", reasoning: "never closed" });
    expect(feed(["<thi"])).toEqual({ shown: "<thi", reasoning: "" });
  });
});
