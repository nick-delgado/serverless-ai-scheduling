import { type ChatRequest, type ChatStreamEvent, encodeStreamEvent } from "@sched/contracts";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REPLIES, RESTORE_CONVERSATION_ID, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, ChatHttpError, createChatApi } from "./api";
import { ChatProtocolError } from "./streamClient";
import { doneEvent, gate } from "./testUtils";

const request = { clientMessageId: "0b6f3f0e-8a51-4c3e-9d0a-2f6a3c1d9e47", text: "Any openings?" };

/** The Authorization header of every request the mock API receives, per test of the calling block. */
function captureAuthorization() {
  const seen: (string | null)[] = [];
  const listener = ({ request }: { request: Request }) => {
    seen.push(request.headers.get("Authorization"));
  };
  beforeEach(() => {
    seen.length = 0;
    server.events.on("request:start", listener);
  });
  afterEach(() => server.events.removeListener("request:start", listener));
  return seen;
}

async function send(api = createChatApi(), body: ChatRequest = request) {
  const seen: ChatStreamEvent[] = [];
  const events = await api.sendChat(body, (event) => seen.push(event));
  return { seen, events };
}

describe("createChatApi", () => {
  describe("Authorization", () => {
    const seen = captureAuthorization();

    it("sends the injected token raw, on both calls", async () => {
      const api = createChatApi({ getToken: () => Promise.resolve("synthetic-id-token") });
      await api.getSession();
      await send(api);
      expect(seen).toEqual(["synthetic-id-token", "synthetic-id-token"]);
    });

    it("sends no header without a getter, or when it returns nothing", async () => {
      await createChatApi().getSession();
      await send(createChatApi({ getToken: () => Promise.resolve(undefined) }));
      expect(seen).toEqual([null, null]);
    });
  });

  it("returns the parsed session", async () => {
    await expect(createChatApi().getSession()).resolves.toEqual(SESSIONS.upcoming);
  });

  it.each([
    ["unauthorized", 401],
    ["internal", 500],
  ] as const)("throws ChatHttpError for a session %s response", async (sessionFault, status) => {
    configureMockApi({ sessionFault });
    await expect(createChatApi().getSession()).rejects.toEqual(new ChatHttpError(status));
  });

  it("rejects a session body that breaks the contract", async () => {
    server.use(http.post("/api/session", () => HttpResponse.json({ greeting: "Hi" })));
    await expect(createChatApi().getSession()).rejects.toBeInstanceOf(ChatProtocolError);
  });

  it("rejects a 2xx session body that isn't JSON with a ChatProtocolError", async () => {
    server.use(http.post("/api/session", () => HttpResponse.html("<p>Sign in</p>")));
    await expect(createChatApi().getSession()).rejects.toBeInstanceOf(ChatProtocolError);
  });

  describe("abort", () => {
    // The call is aborted as its request starts, and only then may the mock answer; without the
    // signal, neither call ends in an AbortError.
    it.each([
      ["getSession", "/api/session", (api: ChatApi, signal: AbortSignal) => api.getSession(signal)],
      [
        "sendChat",
        "/api/chat",
        (api: ChatApi, signal: AbortSignal) => api.sendChat(request, () => undefined, signal),
      ],
    ] as const)("%s passes its signal to fetch", async (_, path, call) => {
      const hold = gate();
      server.use(
        http.post(path, async () => {
          await hold.promise;
          return HttpResponse.json(SESSIONS.upcoming);
        }),
      );
      const controller = new AbortController();
      server.events.on("request:start", () => {
        controller.abort();
        hold.open();
      });
      const settled = call(createChatApi(), controller.signal).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(await settled).toMatchObject({ name: "AbortError" });
      server.events.removeAllListeners("request:start");
    });
  });

  it("posts the request as JSON and streams every event of the turn", async () => {
    let body: unknown;
    let contentType: string | null = null;
    server.events.on("request:start", ({ request }) => {
      contentType = request.headers.get("Content-Type");
      void request
        .clone()
        .json()
        .then((json: unknown) => (body = json));
    });
    const { seen, events } = await send();
    server.events.removeAllListeners("request:start");
    expect(contentType).toBe("application/json");
    expect(body).toEqual(request);
    expect(seen).toEqual(events);
    expect(seen[0]?.type).toBe("conversation");
    expect(seen.slice(1, -1)).toEqual(REPLIES.tools.events);
    expect(seen.at(-1)?.type).toBe("done");
  });

  it.each(["rate_limited", "unavailable"] as const)(
    "delivers the error event of a %s response instead of throwing",
    async (chatFault) => {
      configureMockApi({ chatFault });
      // A continued conversation, which the mock still answers 429/503 (#160).
      const { seen } = await send(undefined, { ...request, conversationId: RESTORE_CONVERSATION_ID });
      expect(seen).toEqual([expect.objectContaining({ type: "error", retryable: true })]);
    },
  );

  it("throws ChatHttpError(401) for API Gateway's own 401 body", async () => {
    configureMockApi({ chatFault: "unauthorized" });
    await expect(send()).rejects.toEqual(new ChatHttpError(401));
  });

  it("throws ChatHttpError for a non-2xx body that isn't an error event", async () => {
    server.use(http.post("/api/chat", () => HttpResponse.text("Bad gateway", { status: 502 })));
    await expect(send()).rejects.toEqual(new ChatHttpError(502));
  });

  it("throws ChatHttpError for a non-2xx body that is a stream event other than error", async () => {
    const done = encodeStreamEvent(doneEvent());
    server.use(http.post("/api/chat", () => HttpResponse.text(done, { status: 500 })));
    await expect(send()).rejects.toEqual(new ChatHttpError(500));
  });

  it("passes a network failure through", async () => {
    configureMockApi({ chatFault: "network" });
    await expect(send()).rejects.toBeInstanceOf(TypeError);
  });
});
