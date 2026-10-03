import type { ChatStreamEvent } from "@sched/contracts";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { ChatHttpError, createChatApi } from "./api";
import { ChatProtocolError } from "./streamClient";

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

async function send(api = createChatApi()) {
  const seen: ChatStreamEvent[] = [];
  const events = await api.sendChat(request, (event) => seen.push(event));
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

  it("posts the request and streams every event of the turn", async () => {
    let body: unknown;
    server.events.on("request:start", ({ request }) => {
      void request
        .clone()
        .json()
        .then((json: unknown) => (body = json));
    });
    const { seen, events } = await send();
    server.events.removeAllListeners("request:start");
    expect(body).toEqual(request);
    expect(seen).toEqual(events);
    expect(seen.slice(0, -1)).toEqual(REPLIES.tools.events);
    expect(seen.at(-1)?.type).toBe("done");
  });

  it.each(["rate_limited", "unavailable"] as const)(
    "delivers the error event of a %s response instead of throwing",
    async (chatFault) => {
      configureMockApi({ chatFault });
      const { seen } = await send();
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

  it("passes a network failure through", async () => {
    configureMockApi({ chatFault: "network" });
    await expect(send()).rejects.toBeInstanceOf(TypeError);
  });
});
