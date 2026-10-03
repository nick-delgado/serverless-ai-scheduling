import {
  ApiError,
  type ChatStreamEvent,
  isTerminalEvent,
  parseChatResponseBody,
  parseStreamEventLine,
  SessionResponse,
  visibleText,
} from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { REPLIES, RESTORE_CONVERSATION_ID, SESSIONS } from "./fixtures";
import { NDJSON_CONTENT_TYPE, ndjsonStream } from "./handlers";
import { configureMockApi } from "./node";
import { DEFAULT_MOCK_API_OPTIONS, parseMockApiOptions } from "./options";

const CLIENT_MESSAGE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function postChat(
  body: unknown = { clientMessageId: CLIENT_MESSAGE_ID, text: "Any openings with Dr. Lee?" },
) {
  return fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read an NDJSON body chunk by chunk, as the chat client will, recording each event's arrival. */
async function readEvents(
  res: Response,
): Promise<{ events: ChatStreamEvent[]; chunks: number; arrivals: number[] }> {
  if (!res.body) throw new Error("No body");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: ChatStreamEvent[] = [];
  const arrivals: number[] = [];
  let chunks = 0;
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    arrivals.push(performance.now());
    chunks += 1;
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) events.push(parseStreamEventLine(line));
  }
  expect(buffered).toBe(""); // every event ends with a newline
  return { events, chunks, arrivals };
}

/** Milliseconds from now until `promise` settles (resolved or rejected). */
async function elapsedUntilSettled(promise: Promise<unknown>): Promise<number> {
  const start = performance.now();
  await promise.catch(() => undefined);
  return performance.now() - start;
}

describe("POST /api/session", () => {
  it.each(["upcoming", "no_upcoming", "restore"] as const)(
    "returns the %s session, valid against the contract",
    async (session) => {
      configureMockApi({ session });
      const res = await fetch("/api/session", { method: "POST" });
      expect(res.status).toBe(200);
      const body = SessionResponse.parse(await res.json());
      expect(body).toEqual(SESSIONS[session]);
    },
  );

  it("injects a 401, a 500 with an ApiError body, and a network failure", async () => {
    configureMockApi({ sessionFault: "unauthorized" });
    const unauthorized = await fetch("/api/session", { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ message: "Unauthorized" });

    configureMockApi({ sessionFault: "internal" });
    const internal = await fetch("/api/session", { method: "POST" });
    expect(internal.status).toBe(500);
    expect(ApiError.parse(await internal.json()).error.code).toBe("INTERNAL");

    configureMockApi({ sessionFault: "network" });
    await expect(fetch("/api/session", { method: "POST" })).rejects.toThrow();
  });

  it("waits latencyMs before answering", async () => {
    configureMockApi({ latencyMs: 80 });
    expect(await elapsedUntilSettled(fetch("/api/session", { method: "POST" }))).toBeGreaterThanOrEqual(60);
  });
});

describe("POST /api/chat", () => {
  it("streams status, then text deltas, then done, as NDJSON", async () => {
    const res = await postChat();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(NDJSON_CONTENT_TYPE);
    const { events } = await readEvents(res);

    expect(events[0]).toMatchObject({ type: "status", tool: "check_availability" });
    expect(events.slice(1, -1).every((e) => e.type === "text_delta")).toBe(true);
    expect(events.length).toBeGreaterThan(10);
    expect(events.at(-1)?.type).toBe("done");
    expect(visibleText(events)).toBe(REPLIES.tools.text);
  });

  it("starts a conversation, then continues it with increasing message IDs", async () => {
    const first = (await readEvents(await postChat())).events.at(-1);
    if (first?.type !== "done") throw new Error("expected done");
    expect(first.messageId).toBe("msg_000002");

    const second = (
      await readEvents(
        await postChat({
          conversationId: first.conversationId,
          clientMessageId: CLIENT_MESSAGE_ID,
          text: "Book Wednesday.",
        }),
      )
    ).events.at(-1);
    expect(second).toMatchObject({
      type: "done",
      conversationId: first.conversationId,
      messageId: "msg_000004",
    });
  });

  it("continues the restored conversation after its last message", async () => {
    const { events } = await readEvents(
      await postChat({
        conversationId: RESTORE_CONVERSATION_ID,
        clientMessageId: CLIENT_MESSAGE_ID,
        text: "Yes please.",
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      conversationId: RESTORE_CONVERSATION_ID,
      messageId: "msg_000004",
    });
  });

  it("plays a text_reset that the client rule resolves to the stored text", async () => {
    configureMockApi({ chatReply: "reset" });
    const { events } = await readEvents(await postChat());
    const reset = events.findIndex((e) => e.type === "text_reset");
    expect(reset).toBeGreaterThan(0);
    expect(visibleText(events.slice(0, reset))).not.toBe(visibleText(events.slice(0, reset + 1)));
    expect(visibleText(events)).toBe(REPLIES.reset.text);
  });

  it("holds the response headers until the first event, then streams events in separate chunks", async () => {
    configureMockApi({ firstEventMs: 120, eventIntervalMs: 5, chatReply: "plain" });
    const sent = performance.now();
    const res = await postChat();
    expect(performance.now() - sent).toBeGreaterThanOrEqual(100);
    const { events, chunks } = await readEvents(res);
    expect(chunks).toBe(events.length);
  });

  it("waits eventIntervalMs between events after the first", async () => {
    configureMockApi({ eventIntervalMs: 25, chatReply: "plain" });
    const { arrivals } = await readEvents(await postChat());
    expect(arrivals.length).toBeGreaterThan(2);
    const gaps = arrivals.slice(1).map((t, i) => t - (arrivals[i] ?? t));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(18);
  });

  // Every response that doesn't wait on the model: the faults that answer before the body is read,
  // the 400 for a malformed body, and the 429/503 faults.
  it.each([
    ["network", undefined],
    ["unauthorized", undefined],
    ["none", { clientMessageId: "not-a-uuid", text: "" }],
    ["rate_limited", undefined],
    ["unavailable", undefined],
  ] as const)("waits latencyMs before answering with chatFault %s", async (chatFault, body) => {
    configureMockApi({ chatFault, latencyMs: 80 });
    expect(await elapsedUntilSettled(postChat(body))).toBeGreaterThanOrEqual(60);
  });

  // `network` and `unauthorized` answer before the body is read (API Gateway rejects first).
  it.each(["none", "rate_limited", "unavailable", "mid_stream"] as const)(
    "answers a malformed body with 400 and one BAD_REQUEST event (chatFault %s)",
    async (chatFault) => {
      configureMockApi({ chatFault });
      const res = await postChat({ clientMessageId: "not-a-uuid", text: "" });
      expect(res.status).toBe(400);
      expect(parseChatResponseBody(await res.text())).toEqual([
        expect.objectContaining({ type: "error", code: "BAD_REQUEST", retryable: false }),
      ]);
    },
  );

  it.each([
    ["rate_limited", 429, "RATE_LIMITED"],
    ["unavailable", 503, "AGENT_UNAVAILABLE"],
  ] as const)("injects %s as %i with one retryable %s event", async (chatFault, status, code) => {
    configureMockApi({ chatFault });
    const res = await postChat();
    expect(res.status).toBe(status);
    expect(parseChatResponseBody(await res.text())).toEqual([
      expect.objectContaining({ type: "error", code, retryable: true }),
    ]);
  });

  it("injects a failure mid-stream: 200, part of the reply, then a retryable error", async () => {
    configureMockApi({ chatFault: "mid_stream" });
    const res = await postChat();
    expect(res.status).toBe(200);
    const { events } = await readEvents(res);
    const partial = visibleText(events);
    expect(partial).not.toBe("");
    expect(partial.length).toBeLessThan(REPLIES.tools.text.length);
    expect(REPLIES.tools.text.startsWith(partial)).toBe(true);
    expect(events.filter(isTerminalEvent)).toEqual([
      expect.objectContaining({ type: "error", code: "AGENT_UNAVAILABLE", retryable: true }),
    ]);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("injects API Gateway's 401 and a network failure", async () => {
    configureMockApi({ chatFault: "unauthorized" });
    const res = await postChat();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "Unauthorized" });

    configureMockApi({ chatFault: "network" });
    await expect(postChat()).rejects.toThrow();
  });
});

describe("ndjsonStream", () => {
  it("stops sending events once the client aborts", async () => {
    const controller = new AbortController();
    const res = ndjsonStream(REPLIES.plain.events, 20, controller.signal);
    if (!res.body) throw new Error("No body");
    const reader = res.body.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });
});

describe("parseMockApiOptions", () => {
  it("keeps valid fields and defaults bad or missing ones", () => {
    expect(
      parseMockApiOptions({
        firstEventMs: 3000,
        chatFault: "mid_stream",
        eventIntervalMs: -1,
        session: "nope",
      }),
    ).toEqual({
      ...DEFAULT_MOCK_API_OPTIONS,
      firstEventMs: 3000,
      chatFault: "mid_stream",
    });
    expect(parseMockApiOptions("garbage")).toEqual(DEFAULT_MOCK_API_OPTIONS);
  });
});
