import type { ChatStreamEvent, SessionResponse } from "@sched/contracts";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { fakeTime, gate, sendNow, serveEvents, typingIndicator as typing, until } from "./testUtils";
import { FALLBACK_GREETING, GENERIC_ERROR, prefersReducedMotion, useChat } from "./useChat";

const CONVERSATION_ID = "5a0c9e7b-3d2f-4b61-8e4a-7c1f0d9b2e63";
const done: ChatStreamEvent = {
  type: "done",
  conversationId: CONVERSATION_ID,
  messageId: "msg_000042",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const status = (label: string): ChatStreamEvent => ({ type: "status", tool: "check_availability", label });
const delta = (text: string): ChatStreamEvent => ({ type: "text_delta", text });

const instant = () => true;
const log = () => screen.getByRole("list", { name: "Conversation" });

async function renderPage(reducedMotion?: () => boolean) {
  render(<ChatPage reducedMotion={reducedMotion ?? instant} />);
  await within(log()).findByText(SESSIONS.upcoming.greeting);
}

async function sendFromPage(text: string) {
  await userEvent.setup().type(screen.getByRole("textbox", { name: "Message" }), `${text}{Enter}`);
}

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
});

describe("prefersReducedMotion", () => {
  it.each([true, false])("follows the media query (matches: %s)", (matches) => {
    const matchMedia = vi.fn((query: string) => ({ matches, media: query }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(prefersReducedMotion()).toBe(matches);
    expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("is false where matchMedia doesn't exist", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
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

describe("ChatPage: turn details", () => {
  it("adds a chip per status, skipping a repeat of the latest label, and marks the latest as current", async () => {
    const hold = gate();
    serveEvents(
      [
        status("Checking A…"),
        status("Checking A…"),
        status("Checking B…"),
        status("Checking A…"),
        delta("Done."),
        done,
      ],
      {
        4: hold.promise,
      },
    );
    await renderPage();
    await sendFromPage("Hi");
    const chips = await screen.findByRole("list", { name: "What the assistant is doing" });
    await waitFor(() =>
      expect(
        within(chips)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["Checking A…", "Checking B…", "Checking A…"]),
    );
    const items = within(chips).getAllByRole("listitem");
    expect(items.map((li) => li.classList.contains("chip--current"))).toEqual([false, false, true]);
    hold.open();
    await within(log()).findByText("Done.");
  });

  it("shows the typing indicator again when a text_reset drops every character, and no empty bubble", async () => {
    const hold = gate();
    serveEvents([delta("I can't"), { type: "text_reset", keepChars: 0 }, delta("Sure."), done], {
      2: hold.promise,
    });
    await renderPage();
    await sendFromPage("Hi");
    await waitFor(() => expect(typing()).toBeInTheDocument());
    // greeting + the patient's message; the reset bubble is gone rather than left empty
    expect(within(log()).getAllByRole("listitem")).toHaveLength(2);
    hold.open();
    expect(await within(log()).findByText("Sure.")).toBeVisible();
    expect(typing()).not.toBeInTheDocument();
  });

  it("marks the reply busy while it types", async () => {
    const hold = gate();
    serveEvents([delta("Part one. "), delta("Part two."), done], { 1: hold.promise });
    await renderPage();
    await sendFromPage("Hi");
    const bubble = await within(log()).findByText("Part one.");
    expect(bubble).toHaveAttribute("aria-busy", "true");
    hold.open();
    const final = await within(log()).findByText("Part one. Part two.");
    expect(final).not.toHaveAttribute("aria-busy");
  });

  it("keeps a completed reply when the connection fails after done", async () => {
    let failed!: Promise<unknown>;
    const real = createChatApi();
    const api: ChatApi = {
      getSession: (signal) => real.getSession(signal),
      sendChat: (_request, onEvent) => {
        onEvent(delta("All set."));
        onEvent(done);
        failed = Promise.reject(new TypeError("connection reset"));
        return failed as Promise<ChatStreamEvent[]>;
      },
    };
    render(<ChatPage api={api} reducedMotion={instant} />);
    await within(log()).findByText(SESSIONS.upcoming.greeting);
    await sendFromPage("Hi");
    expect(await within(log()).findByText("All set.")).toBeVisible();
    await act(() => failed.catch(() => undefined));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(log()).getByText("All set.")).toBeVisible();
  });

  it("clears the error when the next message is sent", async () => {
    configureMockApi({ chatFault: "network" });
    await renderPage();
    await sendFromPage("Hi");
    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    configureMockApi({ chatFault: "none" });
    await sendFromPage("Again");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await within(log()).findByText(REPLIES.tools.text);
  });

  it("stops the request and the typing when the page unmounts", async () => {
    let chatSignal: AbortSignal | undefined;
    const real = createChatApi();
    const api: ChatApi = {
      getSession: (signal) => real.getSession(signal),
      sendChat: (request, onEvent, signal) => {
        chatSignal = signal;
        return real.sendChat(request, onEvent, signal);
      },
    };
    const hold = gate();
    serveEvents([delta("a".repeat(400)), done], { 1: hold.promise });
    fakeTime();
    const { unmount } = render(<ChatPage api={api} reducedMotion={() => false} />);
    await until(() => within(log()).queryByText(SESSIONS.upcoming.greeting) !== null);
    sendNow("Hi");
    await until(() => typing() === null);
    await act(() => vi.advanceTimersByTimeAsync(100));
    // Typing is under way (the stream is held before done): the typewriter's next tick is pending.
    expect(within(log()).getByText(/^a+$/)).toBeVisible();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(chatSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    hold.open();
  });

  it("scrolls the end of the conversation into view as the reply arrives", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      await renderPage();
      scrollIntoView.mockClear();
      await sendFromPage("Hi");
      await within(log()).findByText(REPLIES.tools.text);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});
