import type { ChatStreamEvent, SessionResponse } from "@sched/contracts";
import { act, render, renderHook, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import {
  doneEvent,
  fakeTime,
  instant,
  log,
  sendNow,
  serveChunks,
  serveEvents,
  typingIndicator as typing,
  until,
} from "./testUtils";
import { FALLBACK_GREETING, prefersReducedMotion, useChat } from "./useChat";

const done = doneEvent({ messageId: "msg_000042" });
const delta = (text: string): ChatStreamEvent => ({ type: "text_delta", text });

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
    await waitFor(() => expect(result.current.responding).toBe(false));
  });

  it("keys the reply with the messageId from done", async () => {
    serveEvents([delta("Hello."), done]);
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages[1]).toEqual({ id: "msg_000042", role: "assistant", text: "Hello." });
  });

  it("keeps a greeting the aborted first call of a strict-mode remount would overwrite", async () => {
    let calls = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const api: ChatApi = {
      getSession(signal) {
        calls += 1;
        signals.push(signal);
        if (calls === 1) {
          // Rejects only after the second call has resolved.
          return new Promise<SessionResponse>((_, reject) =>
            signal?.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), 30)),
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
    expect(await within(log()).findByText(SESSIONS.no_upcoming.greeting)).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 60));
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
