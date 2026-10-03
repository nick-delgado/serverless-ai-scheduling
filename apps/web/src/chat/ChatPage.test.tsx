import { type ChatStreamEvent, LIMITS, TOOL_STATUS_LABELS } from "@sched/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { COUNTER_FROM } from "./Composer";
import {
  fakeTime,
  gate,
  sendNow,
  serveChunks,
  serveEvents,
  typingIndicator as typing,
  until,
} from "./testUtils";
import { FALLBACK_GREETING } from "./useChat";

const instant = () => true;
const CONVERSATION_ID = "5a0c9e7b-3d2f-4b61-8e4a-7c1f0d9b2e63";
const done: ChatStreamEvent = {
  type: "done",
  conversationId: CONVERSATION_ID,
  messageId: "msg_000002",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
};
const availability: ChatStreamEvent = {
  type: "status",
  tool: "check_availability",
  label: TOOL_STATUS_LABELS.check_availability,
};

/** Render under fake time and wait (in real hops) for the greeting. */
async function renderAtFakeTime(reducedMotion: () => boolean) {
  fakeTime();
  render(<ChatPage reducedMotion={reducedMotion} />);
  await until(() => screen.queryByText(SESSIONS.upcoming.greeting, { selector: "li" }) !== null);
}

function renderChat(props: { api?: ChatApi; reducedMotion?: () => boolean } = {}) {
  const user = userEvent.setup();
  render(<ChatPage reducedMotion={instant} {...props} />);
  const input = screen.getByRole("textbox", { name: "Message" });
  const sendButton = screen.getByRole("button", { name: "Send" });
  const log = screen.getByRole("list", { name: "Conversation" });
  return { user, input, sendButton, log };
}

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
    expect(screen.getByTestId("announcer")).toBeEmptyDOMElement();
    expect(typing()).toBeInTheDocument();
    expect(await within(log).findByText(SESSIONS.upcoming.greeting)).toBeVisible();
    expect(typing()).not.toBeInTheDocument();
    expect(screen.getByTestId("announcer")).toHaveTextContent(SESSIONS.upcoming.greeting);
  });

  it("falls back to a generic greeting when the session call fails", async () => {
    configureMockApi({ sessionFault: "internal" });
    const { log } = renderChat();
    expect(await within(log).findByText(FALLBACK_GREETING)).toBeVisible();
    expect(screen.getByTestId("announcer")).toHaveTextContent(FALLBACK_GREETING);
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
    const hold = gate();
    serveEvents([{ type: "text_delta", text: "Sure." }, done], { 0: hold.promise });
    const bodies = captureChatBodies();
    const { user, input, sendButton, log } = renderChat();
    await user.type(input, "First{Enter}");
    await user.type(input, "Second");
    expect(sendButton).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("Second");
    hold.open();
    expect(await within(log).findByText("Sure.")).toBeVisible();
    expect(sendButton).toBeEnabled();
    expect(bodies).toHaveLength(1);
  });
});

describe("ChatPage: a turn", () => {
  it("shows the typing indicator from send until the first text, with a chip for the tool status", async () => {
    const [statusSent, textSent] = [gate(), gate()];
    serveEvents(
      [
        availability,
        { type: "text_delta", text: "Dr. Lee " },
        { type: "text_delta", text: "is free." },
        done,
      ],
      {
        0: statusSent.promise,
        1: textSent.promise,
      },
    );
    const { log } = renderChat();
    await within(log).findByText(SESSIONS.upcoming.greeting);
    sendNow("Any openings?");
    // From send, before any response: the real API sends no headers until its first event.
    expect(typing()).toBeInTheDocument();

    // A status event: a chip, still typing.
    statusSent.open();
    expect(await screen.findByText(TOOL_STATUS_LABELS.check_availability)).toBeVisible();
    expect(typing()).toBeInTheDocument();

    // The first text_delta ends the indicator; the chip stays for the rest of the turn.
    textSent.open();
    expect(await within(log).findByText(/^Dr\. Lee/)).toBeVisible();
    expect(typing()).not.toBeInTheDocument();

    // When the turn completes, the chips go.
    expect(await within(log).findByText("Dr. Lee is free.")).toBeVisible();
    expect(screen.queryByText(TOOL_STATUS_LABELS.check_availability)).not.toBeInTheDocument();
  });

  it("types the reply out a character at a time, even when it all arrives at once", async () => {
    const text = REPLIES.plain.text;
    serveChunks([[{ type: "text_delta", text }, done]]);
    await renderAtFakeTime(() => false);
    sendNow("Hi");
    // The whole reply and its done are in; fake time hasn't moved, so nothing is typed yet.
    await until(() => typing() === null);
    const log = screen.getByRole("list", { name: "Conversation" });
    const bubble = () => within(log).getAllByRole("listitem").at(-1);
    expect(bubble()).toHaveTextContent("You: Hi");

    // Default pace: 60/s, or backlog / 0.75 s while the backlog is larger (here ~160/s at first).
    await act(() => vi.advanceTimersByTimeAsync(200));
    const early = bubble()?.textContent ?? "";
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(text.length / 2);
    expect(text.startsWith(early)).toBe(true);
    expect(bubble()).toHaveAttribute("aria-busy", "true");

    await act(() => vi.advanceTimersByTimeAsync(200));
    expect((bubble()?.textContent ?? "").length).toBeGreaterThan(early.length);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(bubble()).toHaveTextContent(text);
    expect(bubble()).not.toHaveAttribute("aria-busy");
  });

  it("renders the reply at once under prefers-reduced-motion", async () => {
    serveChunks([[{ type: "text_delta", text: REPLIES.plain.text }, done]]);
    await renderAtFakeTime(instant);
    sendNow("Hi");
    // No fake time passes, so no typewriter tick can run.
    await until(() => screen.queryByText(REPLIES.plain.text, { selector: "li" }) !== null);
  });

  it("applies text_reset: the bubble ends with exactly the stored text", async () => {
    configureMockApi({ chatReply: "reset" });
    const { user, input, log } = renderChat();
    await user.type(input, "Hi{Enter}");
    expect(await within(log).findByText(REPLIES.reset.text)).toBeVisible();
    expect(log).not.toHaveTextContent("I'm not able to");
  });

  it("announces the completed reply once, never a partial one", async () => {
    serveChunks([[{ type: "text_delta", text: REPLIES.plain.text }, done]]);
    await renderAtFakeTime(() => false);
    const announcer = screen.getByTestId("announcer");
    const announced: string[] = [];
    const observer = new MutationObserver(() => announced.push(announcer.textContent));
    observer.observe(announcer, { childList: true, characterData: true, subtree: true });

    sendNow("Hi");
    await until(() => typing() === null);
    // One tick per act(), so each partial render reaches the DOM (one long act commits only the end).
    const bubbles = new Set<string>();
    for (let tick = 0; tick < 300; tick += 1) {
      await act(() => vi.advanceTimersByTimeAsync(16));
      bubbles.add(screen.getByRole("list", { name: "Conversation" }).lastElementChild?.textContent ?? "");
    }
    observer.disconnect();
    expect(bubbles.size).toBeGreaterThan(10); // the reply was typed out in steps meanwhile
    expect(screen.queryByText(REPLIES.plain.text, { selector: "li" })).toBeVisible();
    expect(announced.filter((text) => text.length > 0)).toEqual([REPLIES.plain.text]);
  });

  it("continues the conversation the first turn's done event started", async () => {
    serveEvents([{ type: "text_delta", text: "Sure." }, done]);
    const bodies = captureChatBodies();
    const { user, input, log } = renderChat();
    await user.type(input, "One{Enter}");
    await waitFor(() => expect(within(log).getAllByText("Sure.")).toHaveLength(1));
    await user.type(input, "Two{Enter}");
    await waitFor(() => expect(within(log).getAllByText("Sure.")).toHaveLength(2));
    const [first, second] = bodies as { conversationId?: string; clientMessageId: string }[];
    expect(first?.conversationId).toBeUndefined();
    expect(second?.conversationId).toBe(CONVERSATION_ID);
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
