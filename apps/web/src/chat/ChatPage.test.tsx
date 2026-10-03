import { LIMITS, TOOL_STATUS_LABELS } from "@sched/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { COUNTER_FROM } from "./Composer";
import { FALLBACK_GREETING } from "./useChat";

const instant = () => true;

/**
 * Fake only timers and Date: fetch and MSW schedule their own work with setImmediate and microtasks,
 * which must keep running for the stream to flow. user-event stalls under fake timers, so these tests
 * type with `sendNow` (fireEvent) instead.
 */
function fakeTime() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/** Render under fake time and let the session call settle. */
async function renderAtFakeTime(reducedMotion: () => boolean) {
  fakeTime();
  render(<ChatPage reducedMotion={reducedMotion} />);
  await act(() => vi.advanceTimersByTimeAsync(0));
}

function sendNow(text: string) {
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

function renderChat(props: { api?: ChatApi; reducedMotion?: () => boolean } = {}) {
  const user = userEvent.setup();
  render(<ChatPage reducedMotion={instant} {...props} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  const sendButton = screen.getByRole("button", { name: "Send" });
  const log = screen.getByRole("list", { name: "Conversation" });
  return { user, input, sendButton, log };
}

const typing = () => screen.queryByTestId("typing-indicator");
const announcer = () => screen.getByTestId("announcer");

/** Requests the mock API receives for `POST /api/chat`, with their JSON bodies. */
function captureChatBodies() {
  const bodies: unknown[] = [];
  server.events.on("request:start", ({ request }) => {
    if (new URL(request.url).pathname === "/api/chat") {
      void request
        .clone()
        .json()
        .then((json: unknown) => bodies.push(json));
    }
  });
  return bodies;
}

afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
});

describe("ChatPage: greeting", () => {
  it("shows the session's greeting on load, and announces it", async () => {
    const { log } = renderChat();
    expect(typing()).toBeInTheDocument();
    expect(await within(log).findByText(SESSIONS.upcoming.greeting)).toBeVisible();
    expect(typing()).not.toBeInTheDocument();
    expect(announcer()).toHaveTextContent(SESSIONS.upcoming.greeting);
  });

  it("falls back to a generic greeting when the session call fails", async () => {
    configureMockApi({ sessionFault: "internal" });
    const { log } = renderChat();
    expect(await within(log).findByText(FALLBACK_GREETING)).toBeVisible();
  });
});

describe("ChatPage: composer (FR-011)", () => {
  it("disables Send while the text is empty or blank", async () => {
    const { user, input, sendButton } = renderChat();
    expect(sendButton).toBeDisabled();
    await user.type(input, "   ");
    expect(sendButton).toBeDisabled();
    await user.type(input, "hi");
    expect(sendButton).toBeEnabled();
  });

  it("sends on Enter, trimmed, and clears the box", async () => {
    const bodies = captureChatBodies();
    const { user, input, log } = renderChat();
    await user.type(input, "  Any openings?  {Enter}");
    expect(within(log).getByText("Any openings?")).toBeVisible();
    expect(input).toHaveValue("");
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ text: "Any openings?" });
  });

  it("adds a newline on Shift+Enter instead of sending", async () => {
    const bodies = captureChatBodies();
    const { user, input, log } = renderChat();
    await user.type(input, "Line one{Shift>}{Enter}{/Shift}Line two");
    expect(input).toHaveValue("Line one\nLine two");
    expect(bodies).toHaveLength(0);
    await user.keyboard("{Enter}");
    expect(
      within(log)
        .getAllByRole("listitem")
        .find((item) => item.textContent.startsWith("You: ")),
    ).toHaveTextContent("You: Line one\nLine two", {
      normalizeWhitespace: false,
    });
    await waitFor(() => expect(bodies).toEqual([expect.objectContaining({ text: "Line one\nLine two" })]));
  });

  it("doesn't send on Enter while an IME composition is in progress", async () => {
    const bodies = captureChatBodies();
    const { user, input } = renderChat();
    await user.type(input, "konnichiwa");
    const composing = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true });
    act(() => {
      input.dispatchEvent(composing);
    });
    expect(input).toHaveValue("konnichiwa");
    expect(bodies).toHaveLength(0);
  });

  it("sends with the Send button", async () => {
    const { user, input, sendButton, log } = renderChat();
    await user.type(input, "Book me in");
    await user.click(sendButton);
    expect(within(log).getByText("Book me in")).toBeVisible();
  });

  it(`caps the text at ${String(LIMITS.chatTextMaxChars)} characters and shows a counter near the limit`, async () => {
    const { user, input } = renderChat();
    expect(input).toHaveAttribute("maxLength", String(LIMITS.chatTextMaxChars));
    await user.click(input);
    await user.paste("a".repeat(COUNTER_FROM - 1));
    expect(screen.queryByText(/\/ 2,000/)).not.toBeInTheDocument();
    await user.type(input, "a");
    expect(screen.getByText("1,800 / 2,000")).toBeVisible();
    expect(input).toHaveAccessibleDescription("1,800 / 2,000");
    await user.paste("a".repeat(500));
    expect(input).toHaveValue("a".repeat(LIMITS.chatTextMaxChars));
  });

  it("disables Send, and ignores Enter, while the agent responds; typing stays possible", async () => {
    configureMockApi({ firstEventMs: 200 });
    const bodies = captureChatBodies();
    const { user, input, sendButton, log } = renderChat();
    await user.type(input, "First{Enter}");
    await user.type(input, "Second");
    expect(sendButton).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("Second");
    expect(await within(log).findByText(REPLIES.tools.text)).toBeVisible();
    expect(sendButton).toBeEnabled();
    expect(bodies).toHaveLength(1);
  });
});

describe("ChatPage: a turn", () => {
  it("shows the typing indicator from send until the first text, with a chip for the tool status", async () => {
    configureMockApi({ firstEventMs: 1_000, eventIntervalMs: 100 });
    await renderAtFakeTime(instant);
    sendNow("Any openings?");

    // Headers and the first event only arrive after 1 s; the indicator shows from send.
    expect(typing()).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(990));
    expect(typing()).toBeInTheDocument();
    expect(screen.queryByText(TOOL_STATUS_LABELS.check_availability)).not.toBeInTheDocument();

    // The first event is the status: a chip, still typing.
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(screen.getByText(TOOL_STATUS_LABELS.check_availability)).toBeVisible();
    expect(typing()).toBeInTheDocument();

    // The first text_delta, 100 ms later, ends the indicator.
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(typing()).not.toBeInTheDocument();
    expect(screen.getByText(TOOL_STATUS_LABELS.check_availability)).toBeVisible();

    // When the turn completes, the chips go.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(
      within(screen.getByRole("list", { name: "Conversation" })).getByText(REPLIES.tools.text),
    ).toBeVisible();
    expect(screen.queryByText(TOOL_STATUS_LABELS.check_availability)).not.toBeInTheDocument();
  });

  it("types the reply out a character at a time, even when it all arrives at once", async () => {
    configureMockApi({ chatReply: "plain" });
    await renderAtFakeTime(() => false);
    sendNow("Hi");
    // Zero delays: the whole reply is in the client within a few ms of fake time.
    await act(() => vi.advanceTimersByTimeAsync(5));
    const log = screen.getByRole("list", { name: "Conversation" });
    const bubble = () => within(log).getAllByRole("listitem").at(-1)?.textContent ?? "";

    await act(() => vi.advanceTimersByTimeAsync(200));
    const early = bubble();
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(REPLIES.plain.text.length / 2);
    expect(REPLIES.plain.text.startsWith(early)).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(bubble().length).toBeGreaterThan(early.length);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(bubble()).toBe(REPLIES.plain.text);
  });

  it("renders the reply at once under prefers-reduced-motion", async () => {
    const { user, input, log } = renderChat({ reducedMotion: instant });
    await user.type(input, "Hi{Enter}");
    expect(await within(log).findByText(REPLIES.tools.text)).toBeVisible();
  });

  it("applies text_reset: the bubble ends with exactly the stored text", async () => {
    configureMockApi({ chatReply: "reset" });
    const { user, input, log } = renderChat();
    await user.type(input, "Hi{Enter}");
    expect(await within(log).findByText(REPLIES.reset.text)).toBeVisible();
    expect(log).not.toHaveTextContent("I'm not able to");
  });

  it("announces the completed reply once, never a partial one", async () => {
    await renderAtFakeTime(() => false);
    const announced: string[] = [];
    const observer = new MutationObserver(() => announced.push(announcer().textContent));
    observer.observe(announcer(), { childList: true, characterData: true, subtree: true });

    sendNow("Hi");
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    observer.disconnect();
    expect(announced.filter((text) => text.length > 0)).toEqual([REPLIES.tools.text]);
  });

  it("continues the conversation the first turn's done event started", async () => {
    const bodies = captureChatBodies();
    const { user, input, log } = renderChat();
    await user.type(input, "One{Enter}");
    await within(log).findByText(REPLIES.tools.text);
    await user.type(input, "Two{Enter}");
    await waitFor(() => expect(bodies).toHaveLength(2));
    const [first, second] = bodies as { conversationId?: string; clientMessageId: string }[];
    expect(first?.conversationId).toBeUndefined();
    expect(second?.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.clientMessageId).not.toBe(first?.clientMessageId);
  });

  it("sends the injected token", async () => {
    const seen: (string | null)[] = [];
    server.events.on("request:start", ({ request }) => seen.push(request.headers.get("Authorization")));
    const { user, input, log } = renderChat({
      api: createChatApi({ getToken: () => Promise.resolve("synthetic-id-token") }),
    });
    await user.type(input, "Hi{Enter}");
    await within(log).findByText(REPLIES.tools.text);
    expect(seen).toEqual(["synthetic-id-token", "synthetic-id-token"]);
  });

  it.each([
    ["an error event mid-stream", "mid_stream", "The assistant isn't available right now. Please try again."],
    ["a network failure", "network", "Something went wrong. Please try again."],
  ] as const)("ends the turn on %s and shows its message", async (_, chatFault, message) => {
    configureMockApi({ chatFault });
    const { user, input, sendButton, log } = renderChat();
    await user.type(input, "Hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(typing()).not.toBeInTheDocument();
    expect(within(log).getByText("Hi")).toBeVisible();
    await user.type(input, "again");
    expect(sendButton).toBeEnabled();
  });
});
