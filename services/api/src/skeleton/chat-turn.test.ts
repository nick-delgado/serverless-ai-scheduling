import { PassThrough } from "node:stream";

import { APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { isTerminalEvent, parseStreamEventLine, type ChatStreamEvent } from "@sched/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runChatTurn, type ChatTurnInput, type EventSink, type ModelStreamEvent } from "./chat-turn";
import { chatStreamHandler, NDJSON_HEADERS, type RestApiProxyEvent } from "./lambda";

const PATIENT_ID = "3f1c2a5e-8b7d-4c1e-9a2b-6d5e4f3a2b1c";
const CONVERSATION_ID = "0b6f5a7e-2c1d-4e3f-8a9b-1c2d3e4f5a6b";
const NEW_CONVERSATION_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const validBody = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ clientMessageId: "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c", text: "Hello!", ...extra });

const input = (overrides: Partial<ChatTurnInput> = {}): ChatTurnInput => ({
  body: validBody(),
  patientId: PATIENT_ID,
  requestId: "req-1",
  ...overrides,
});

/** A fake of the SDK's raw event stream: message_start, text deltas, message_delta, message_stop. */
async function* fakeSdkStream(
  texts: string[],
  opts: { failAfter?: number; error?: unknown } = {},
): AsyncGenerator<ModelStreamEvent> {
  yield {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 42,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
  yield { type: "content_block_start" };
  for (const [i, text] of texts.entries()) {
    if (opts.failAfter === i) throw opts.error ?? new Error("stream broke");
    yield { type: "content_block_delta", delta: { type: "text_delta", text } };
  }
  yield { type: "content_block_stop" };
  yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 17 } };
  yield { type: "message_stop" };
}

interface Captured {
  status: number | undefined;
  opens: number;
  ended: boolean;
  events: ChatStreamEvent[];
}

function memorySink(): { sink: EventSink; out: Captured } {
  const out: Captured = { status: undefined, opens: 0, ended: false, events: [] };
  const sink: EventSink = {
    open(status) {
      out.status = status;
      out.opens += 1;
    },
    write(chunk) {
      expect(out.opens, "open() must precede the first write").toBe(1);
      expect(chunk.endsWith("\n")).toBe(true);
      out.events.push(parseStreamEventLine(chunk));
    },
    end() {
      out.ended = true;
      return Promise.resolve();
    },
  };
  return { sink, out };
}

function expectWellFormed(out: Captured): void {
  expect(out.ended).toBe(true);
  expect(out.opens).toBe(1);
  expect(out.events.length).toBeGreaterThan(0);
  expect(isTerminalEvent(out.events.at(-1))).toBe(true);
  expect(out.events.filter(isTerminalEvent)).toHaveLength(1);
}

const deps = (open: () => Promise<AsyncIterable<ModelStreamEvent>>) => ({
  openModelStream: vi.fn(open),
  newConversationId: () => NEW_CONVERSATION_ID,
});

describe("runChatTurn", () => {
  it("streams text deltas in order, then done with the usage totals", async () => {
    const d = deps(() => Promise.resolve(fakeSdkStream(["Hi", " there", "!"])));
    const { sink, out } = memorySink();

    await runChatTurn(input(), d, sink);

    expectWellFormed(out);
    expect(out.status).toBe(200);
    expect(out.events).toEqual([
      { type: "text_delta", text: "Hi" },
      { type: "text_delta", text: " there" },
      { type: "text_delta", text: "!" },
      {
        type: "done",
        conversationId: NEW_CONVERSATION_ID,
        messageId: "msg_000001",
        usage: { inputTokens: 42, outputTokens: 17, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
    expect(d.openModelStream).toHaveBeenCalledWith(expect.objectContaining({ userText: "Hello!" }));
  });

  it("echoes an existing conversationId and skips non-text deltas", async () => {
    async function* withThinking(): AsyncGenerator<ModelStreamEvent> {
      yield { type: "content_block_delta", delta: { type: "thinking_delta" } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "" } };
      yield* fakeSdkStream(["ok"]);
    }
    const { sink, out } = memorySink();

    await runChatTurn(
      input({ body: validBody({ conversationId: CONVERSATION_ID }) }),
      deps(() => Promise.resolve(withThinking())),
      sink,
    );

    expectWellFormed(out);
    expect(out.events.map((e) => e.type)).toEqual(["text_delta", "done"]);
    expect(out.events.at(-1)).toMatchObject({ type: "done", conversationId: CONVERSATION_ID });
  });

  it("accepts a base64-encoded body", async () => {
    const { sink, out } = memorySink();
    await runChatTurn(
      input({ body: Buffer.from(validBody()).toString("base64"), isBase64Encoded: true }),
      deps(() => Promise.resolve(fakeSdkStream(["ok"]))),
      sink,
    );
    expectWellFormed(out);
    expect(out.events.at(-1)?.type).toBe("done");
  });

  it.each([
    ["no body", null],
    ["malformed JSON", "{not json"],
    ["missing clientMessageId", JSON.stringify({ text: "hi" })],
    ["blank text", validBody({ text: "   " })],
    // Identity comes from the token only: a patientId in the body is rejected, not ignored.
    ["a patientId field", validBody({ patientId: PATIENT_ID })],
  ])("rejects %s with 400 BAD_REQUEST and never calls the model", async (_label, body) => {
    const d = deps(() => Promise.resolve(fakeSdkStream(["unused"])));
    const { sink, out } = memorySink();

    await runChatTurn(input({ body }), d, sink);

    expectWellFormed(out);
    expect(out.status).toBe(400);
    expect(out.events).toEqual([
      expect.objectContaining({ type: "error", code: "BAD_REQUEST", retryable: false }),
    ]);
    expect(d.openModelStream).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorizer supplied no subject", async () => {
    const d = deps(() => Promise.resolve(fakeSdkStream(["unused"])));
    const { sink, out } = memorySink();

    await runChatTurn(input({ patientId: undefined }), d, sink);

    expectWellFormed(out);
    expect(out.status).toBe(401);
    expect(out.events[0]).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(d.openModelStream).not.toHaveBeenCalled();
  });

  it.each([
    [
      "throttled",
      APIError.generate(429, undefined, "Too many requests", new Headers()),
      429,
      "RATE_LIMITED",
      true,
    ],
    [
      "unavailable",
      APIError.generate(503, undefined, "Service unavailable", new Headers()),
      503,
      "AGENT_UNAVAILABLE",
      true,
    ],
    ["timed out", new APIConnectionTimeoutError(), 503, "AGENT_UNAVAILABLE", true],
    ["denied", APIError.generate(403, undefined, "Access denied", new Headers()), 500, "INTERNAL", false],
  ])("maps a model call that is %s up front to %i %s", async (_label, error, status, code, retryable) => {
    const { sink, out } = memorySink();
    const log = vi.fn();

    await runChatTurn(input(), { ...deps(() => Promise.reject(error)), log }, sink);

    expectWellFormed(out);
    expect(out.status).toBe(status);
    expect(out.events).toEqual([{ type: "error", code, retryable, message: expect.any(String) }]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: "chat turn failed", code }));
  });

  it("ends with an error event (and no done) when the stream breaks midway", async () => {
    const { sink, out } = memorySink();

    await runChatTurn(
      input(),
      deps(() => Promise.resolve(fakeSdkStream(["one", "two", "three"], { failAfter: 2 }))),
      sink,
    );

    expectWellFormed(out);
    expect(out.status).toBe(200);
    expect(out.events.map((e) => e.type)).toEqual(["text_delta", "text_delta", "error"]);
    expect(out.events.at(-1)).toMatchObject({ code: "INTERNAL", retryable: false });
  });

  it("still ends the stream when an event breaks the contract", async () => {
    const { sink, out } = memorySink();
    // A done event needs a valid conversationId; force an invalid one.
    await runChatTurn(
      input(),
      {
        openModelStream: () => Promise.resolve(fakeSdkStream(["hi"])),
        newConversationId: () => "not-a-uuid",
      },
      sink,
    );

    expectWellFormed(out);
    expect(out.events.map((e) => e.type)).toEqual(["text_delta", "error"]);
  });

  it("ends the stream even if writing fails", async () => {
    const { sink, out } = memorySink();
    sink.write = () => {
      throw new Error("client went away");
    };

    await runChatTurn(
      input(),
      deps(() => Promise.resolve(fakeSdkStream(["hi"]))),
      sink,
    );

    expect(out.ended).toBe(true);
  });
});

describe("chatStreamHandler (Lambda adapter)", () => {
  let prelude: awslambda.HttpResponseMetadata | undefined;

  beforeEach(() => {
    prelude = undefined;
    vi.stubGlobal("awslambda", {
      HttpResponseStream: {
        from(stream: awslambda.ResponseStream, metadata: awslambda.HttpResponseMetadata) {
          prelude = metadata;
          return stream;
        },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const proxyEvent = (claims: Record<string, string> | undefined, body = validBody()): RestApiProxyEvent => ({
    body,
    isBase64Encoded: false,
    requestContext: { requestId: "req-2", authorizer: claims ? { claims } : null },
  });

  async function invoke(event: RestApiProxyEvent): Promise<{ body: string; ended: boolean }> {
    const responseStream = new PassThrough();
    const chunks: Buffer[] = [];
    responseStream.on("data", (c: Buffer) => chunks.push(c));
    const handler = chatStreamHandler({
      openModelStream: () => Promise.resolve(fakeSdkStream(["Hello", " world"])),
    });

    await handler(event, responseStream, {});

    return { body: Buffer.concat(chunks).toString("utf8"), ended: responseStream.writableEnded };
  }

  it("writes the NDJSON prelude, the events, and ends the response stream", async () => {
    const { body, ended } = await invoke(proxyEvent({ sub: PATIENT_ID }));

    expect(ended).toBe(true);
    expect(prelude).toEqual({ statusCode: 200, headers: NDJSON_HEADERS });
    const lines = body.trimEnd().split("\n").map(parseStreamEventLine);
    expect(lines.map((e) => e.type)).toEqual(["text_delta", "text_delta", "done"]);
  });

  it("takes the patient from the authorizer claims, not the request", async () => {
    const { body } = await invoke(proxyEvent(undefined));

    expect(prelude?.statusCode).toBe(401);
    expect(parseStreamEventLine(body.trim())).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
  });
});
