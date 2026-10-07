import type { ChatRequest, ChatStreamEvent, SessionResponse } from "@sched/contracts";
import { act, render, renderHook, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, ChatHttpError, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { readLoginSession } from "./loginSession";
import { ChatProtocolError, ChatStreamEndedError } from "./streamClient";
import {
  doneEvent,
  fakeTime,
  gate,
  instant,
  log,
  sendNow,
  serveChunks,
  serveEvents,
  typingIndicator as typing,
  until,
  untilFound,
} from "./testUtils";
import { FALLBACK_GREETING, GENERIC_ERROR, prefersReducedMotion, SIGNED_OUT_ERROR, useChat } from "./useChat";

const done = doneEvent({ messageId: "msg_000042" });
const delta = (text: string): ChatStreamEvent => ({ type: "text_delta", text });

// The waits on the mock API's I/O use `until`, which has no fixed time limit and can outlast the 5 s
// default on a loaded runner: give each test room for it (testUtils.ts, #134).
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

describe("useChat", () => {
  it("refuses a blank message, and a second one while a turn is in progress", async () => {
    configureMockApi({ firstEventMs: 50 });
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    expect(result.current.send("   ")).toBe(false);
    expect(result.current.messages).toEqual([]);
    let first = false;
    let second = true;
    act(() => {
      first = result.current.send("One");
      second = result.current.send("Two");
    });
    expect([first, second]).toEqual([true, false]);
    expect(result.current.messages.map((m) => m.text)).toEqual(["One"]);
    await until(() => !result.current.responding);
    expect(result.current.responding).toBe(false);
  });

  it("keys the reply with the messageId from done", async () => {
    serveEvents([delta("Hello."), done]);
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    act(() => {
      result.current.send("Hi");
    });
    await until(() => result.current.messages.length === 2);
    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1]).toEqual({ id: "msg_000042", role: "assistant", text: "Hello." });
  });

  it("keeps a greeting the aborted first call of a strict-mode remount would overwrite", async () => {
    let calls = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const rejected = gate();
    const api: ChatApi = {
      getSession(signal) {
        calls += 1;
        signals.push(signal);
        if (calls === 1) {
          // Rejects only after the second call has resolved.
          return new Promise<SessionResponse>((_, reject) =>
            signal?.addEventListener("abort", () =>
              setTimeout(() => {
                reject(new Error("aborted"));
                rejected.open();
              }, 30),
            ),
          );
        }
        return Promise.resolve(SESSIONS.no_upcoming);
      },
      sendChat: () => Promise.reject(new Error("unused")),
    };
    render(
      <StrictMode>
        <ChatPage api={api} reducedMotion={instant} />
      </StrictMode>,
    );
    expect(await untilFound(() => within(log()).queryByText(SESSIONS.no_upcoming.greeting))).toBeVisible();
    // Wait for the aborted call's rejection itself rather than sleeping past it (#134). The page's handler
    // was attached to that promise before the gate's, so it has run once the gate opens.
    await act(() => rejected.promise);
    expect(calls).toBe(2);
    expect(signals.map((signal) => signal?.aborted)).toEqual([true, false]);
    expect(within(log()).queryByText(FALLBACK_GREETING)).not.toBeInTheDocument();
  });

  it("reads reduced motion at the start of each turn", async () => {
    const text = REPLIES.plain.text;
    serveChunks([[delta(text), done]]);
    let reduce = false;
    fakeTime();
    render(<ChatPage reducedMotion={() => reduce} />);
    await until(() => within(log()).queryByText(SESSIONS.upcoming.greeting) !== null);

    // Turn one, typed: fake time stands still, so the reply has arrived but none of it is shown.
    sendNow("One");
    await until(() => typing() === null);
    expect(within(log()).queryByText(text)).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(within(log()).getByText(text)).toBeVisible();

    // Turn two, after the preference changed: instant, with fake time still standing still.
    reduce = true;
    sendNow("Two");
    await until(() => within(log()).queryAllByText(text).length === 2);
  });
});

describe("useChat: the conversation an error names (#104)", () => {
  const SUB = "c2a4e6b8-1d3f-4a5b-8c7d-9e0f1a2b3c4d";
  const STORED = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const unavailable = (conversationId?: string): ChatStreamEvent => ({
    type: "error",
    code: "AGENT_UNAVAILABLE",
    message: "The assistant is temporarily unavailable. Please try again.",
    retryable: true,
    ...(conversationId === undefined ? {} : { conversationId }),
  });

  /** A ChatApi that answers each send with the next scripted event and records the requests. */
  function scriptedApi(answers: ChatStreamEvent[]) {
    const bodies: ChatRequest[] = [];
    const api: ChatApi = {
      getSession: () => Promise.resolve(SESSIONS.no_upcoming),
      sendChat: (request, onEvent) => {
        bodies.push(request);
        const answer = answers[bodies.length - 1];
        if (!answer) return Promise.resolve([]);
        onEvent(answer);
        return Promise.resolve([answer]);
      },
    };
    return { api, bodies };
  }

  async function sendThenRetry(answers: ChatStreamEvent[]) {
    localStorage.clear();
    const { api, bodies } = scriptedApi(answers);
    const { result } = renderHook(() => useChat(api, { reducedMotion: instant, sub: SUB }));
    await waitFor(() => expect(result.current.greeting.state).toBe("ready"));
    for (const text of answers.slice(0, -1).map((_, i) => `Message ${i}`)) {
      act(() => {
        result.current.send(text);
      });
      await waitFor(() => expect(result.current.responding).toBe(false));
    }
    expect(result.current.error?.retryable).toBe(true);
    act(() => result.current.retry());
    await waitFor(() => expect(bodies).toHaveLength(answers.length));
    return bodies;
  }

  it("sends the conversation a failed first turn's error names with Retry", async () => {
    const bodies = await sendThenRetry([
      unavailable(STORED),
      doneEvent({ conversationId: STORED, messageId: "msg_000001" }),
    ]);
    expect(bodies[0]?.conversationId).toBeUndefined();
    expect(bodies[1]).toEqual({ ...bodies[0], conversationId: STORED });
  });

  it("writes the login session from the error, before any done", async () => {
    localStorage.clear();
    const { api } = scriptedApi([unavailable(STORED)]);
    const { result } = renderHook(() => useChat(api, { reducedMotion: instant, sub: SUB }));
    await waitFor(() => expect(result.current.greeting.state).toBe("ready"));
    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(readLoginSession()).toEqual({ sub: SUB, conversationId: STORED });
  });

  it("keeps the conversation it has when an error names none", async () => {
    const other = doneEvent({ conversationId: STORED, messageId: "msg_000001" });
    const bodies = await sendThenRetry([other, unavailable(), done]);
    expect(bodies[1]?.conversationId).toBe(STORED);
    expect(bodies[2]?.conversationId).toBe(STORED);
  });
});

describe("useChat: which failures without an error event offer Retry (#138)", () => {
  /** A ChatApi whose first send rejects with `failure` and whose later sends succeed; records the requests. */
  function failingApi(failure: unknown) {
    const bodies: ChatRequest[] = [];
    const api: ChatApi = {
      getSession: () => Promise.resolve(SESSIONS.no_upcoming),
      sendChat: (request, onEvent) => {
        bodies.push(request);
        if (bodies.length === 1) return Promise.reject(failure);
        onEvent(done);
        return Promise.resolve([done]);
      },
    };
    return { api, bodies };
  }

  async function sendFailing(failure: unknown, onUnauthorized = vi.fn()) {
    const { api, bodies } = failingApi(failure);
    const { result } = renderHook(() => useChat(api, { reducedMotion: instant, onUnauthorized }));
    await waitFor(() => expect(result.current.greeting.state).toBe("ready"));
    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    return { result, bodies, onUnauthorized };
  }

  it.each([
    ["a 500 without an event (the threshold)", new ChatHttpError(500)],
    ["a 504 without an event", new ChatHttpError(504)],
    ["a stream that ended before done or error", new ChatStreamEndedError("ended")],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("offers Retry for %s, which resends the same request", async (_, failure) => {
    const { result, bodies } = await sendFailing(failure);
    expect(result.current.error).toEqual({ message: GENERIC_ERROR, retryable: true });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    // Nothing named a conversation before the failure, so the first turn's Retry has none (#160).
    expect(bodies[1]?.conversationId).toBeUndefined();
  });

  it.each([
    ["a 499 without an event (just under the threshold)", new ChatHttpError(499)],
    ["a 429 without an event (API Gateway's throttle)", new ChatHttpError(429)],
    ["a malformed stream", new ChatProtocolError("unreadable")],
  ])("shows the generic error without Retry for %s", async (_, failure) => {
    const { result, onUnauthorized } = await sendFailing(failure);
    expect(result.current.error).toEqual({ message: GENERIC_ERROR, retryable: false });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("signs out on a 401 without an event, without Retry, before any 5xx or network rule", async () => {
    const { result, onUnauthorized } = await sendFailing(new ChatHttpError(401));
    expect(result.current.error).toEqual({ message: SIGNED_OUT_ERROR, retryable: false });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe("useChat: the conversation event (#160)", () => {
  const SUB = "c2a4e6b8-1d3f-4a5b-8c7d-9e0f1a2b3c4d";
  const NAMED = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const named: ChatStreamEvent = { type: "conversation", conversationId: NAMED };

  /** A ChatApi whose first send delivers the conversation event, then rejects with `failure`. */
  function cutAfterNaming(failure: unknown) {
    const bodies: ChatRequest[] = [];
    const api: ChatApi = {
      getSession: () => Promise.resolve(SESSIONS.no_upcoming),
      sendChat: (request, onEvent) => {
        bodies.push(request);
        if (bodies.length === 1) {
          onEvent(named);
          return Promise.reject(failure);
        }
        const answer = doneEvent({ conversationId: NAMED, messageId: "msg_000001" });
        onEvent(answer);
        return Promise.resolve([answer]);
      },
    };
    return { api, bodies };
  }

  it.each([
    ["a stream cut after it", new ChatStreamEndedError("ended")],
    ["a network error mid-read", new TypeError("network error")],
  ])("Retry after %s resends with the conversation it named", async (_, failure) => {
    localStorage.clear();
    const { api, bodies } = cutAfterNaming(failure);
    const { result } = renderHook(() => useChat(api, { reducedMotion: instant, sub: SUB }));
    await waitFor(() => expect(result.current.greeting.state).toBe("ready"));
    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() => expect(result.current.error).toEqual({ message: GENERIC_ERROR, retryable: true }));
    // Remembered as `done` would be: for the next send and for a reload (FR-014).
    expect(readLoginSession()).toEqual({ sub: SUB, conversationId: NAMED });

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(bodies[0]?.conversationId).toBeUndefined();
    expect(bodies[1]).toEqual({ ...bodies[0], conversationId: NAMED });
  });
});

describe("prefersReducedMotion", () => {
  it.each([true, false])("follows the media query (matches: %s)", (matches) => {
    const matchMedia = vi.fn((query: string) => ({ matches, media: query }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(prefersReducedMotion()).toBe(matches);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("is what the page uses by default", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
    configureMockApi({ chatReply: "plain" });
    fakeTime();
    render(<ChatPage />);
    await until(() => within(log()).queryByText(SESSIONS.upcoming.greeting) !== null);
    sendNow("Hi");
    // Fake time stands still, so no typewriter tick can run: the reply must appear without one.
    await until(() => within(log()).queryByText(REPLIES.plain.text) !== null);
  });
});
