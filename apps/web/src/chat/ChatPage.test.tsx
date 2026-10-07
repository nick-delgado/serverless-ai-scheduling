import { type ChatStreamEvent, LIMITS, TOOL_STATUS_LABELS } from "@sched/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, createChatApi } from "./api";
import { ChatApiContext, ChatPage } from "./ChatPage";
import { COUNTER_FROM } from "./Composer";
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
import { FALLBACK_GREETING, GENERIC_ERROR } from "./useChat";

const done = doneEvent();
const status = (label: string): ChatStreamEvent => ({ type: "status", tool: "check_availability", label });
const delta = (text: string): ChatStreamEvent => ({ type: "text_delta", text });
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

/** Render with instant replies and wait (in real hops, no fixed timeout) for the greeting. */
async function renderPage() {
  render(<ChatPage reducedMotion={instant} />);
  await until(() => within(log()).queryByText(SESSIONS.upcoming.greeting) !== null);
}

async function sendFromPage(text: string) {
  await userEvent.setup().type(screen.getByRole("textbox", { name: "Message" }), `${text}{Enter}`);
}

/** Record every text the live region holds, from now until `stop()`. */
function recordAnnouncements() {
  const announcer = screen.getByTestId("announcer");
  const announced: string[] = [];
  const observer = new MutationObserver(() => announced.push(announcer.textContent));
  observer.observe(announcer, { childList: true, characterData: true, subtree: true });
  return {
    stop: () => {
      observer.disconnect();
      return announced.filter((text) => text.length > 0);
    },
  };
}

// The waits on the mock API's I/O use `until`, which has no fixed time limit and can outlast the 5 s
// default on a loaded runner: give each test room for it (testUtils.ts, #134).
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  server.events.removeAllListeners();
  vi.useRealTimers();
});

describe("ChatPage: greeting", () => {
  it("shows the session's greeting on load, and announces it", async () => {
    const { log } = renderChat();
    expect(screen.getByTestId("announcer")).toBeEmptyDOMElement();
    expect(typing()).toBeInTheDocument();
    expect(await untilFound(() => within(log).queryByText(SESSIONS.upcoming.greeting))).toBeVisible();
    expect(typing()).not.toBeInTheDocument();
    expect(screen.getByTestId("announcer")).toHaveTextContent(SESSIONS.upcoming.greeting);
  });

  it("takes its API from ChatApiContext when no api prop is given", async () => {
    const seen: (string | null)[] = [];
    server.events.on("request:start", ({ request }) => seen.push(request.headers.get("Authorization")));
    render(
      <ChatApiContext value={createChatApi({ getToken: () => Promise.resolve("synthetic-id-token") })}>
        <ChatPage reducedMotion={instant} />
      </ChatApiContext>,
    );
    await untilFound(() => within(log()).queryByText(SESSIONS.upcoming.greeting));
    expect(seen).toEqual(["synthetic-id-token"]);
  });

  it("falls back to a generic greeting when the session call fails", async () => {
    configureMockApi({ sessionFault: "internal" });
    const { log } = renderChat();
    expect(await untilFound(() => within(log).queryByText(FALLBACK_GREETING))).toBeVisible();
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
    await until(() => bodies.length === 1);
    expect(bodies).toHaveLength(1);
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
    await until(() => bodies.length === 1);
    expect(bodies).toEqual([expect.objectContaining({ text: "Line one\nLine two" })]);
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
    expect(await untilFound(() => within(log).queryByText("Sure."))).toBeVisible();
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
    await untilFound(() => within(log).queryByText(SESSIONS.upcoming.greeting));
    sendNow("Any openings?");
    // From send, before any response: the real API sends no headers until its first event.
    expect(typing()).toBeInTheDocument();

    // A status event: a chip, still typing.
    statusSent.open();
    expect(await untilFound(() => screen.queryByText(TOOL_STATUS_LABELS.check_availability))).toBeVisible();
    expect(typing()).toBeInTheDocument();

    // The first text_delta ends the indicator; the chip stays for the rest of the turn.
    textSent.open();
    expect(await untilFound(() => within(log).queryByText(/^Dr\. Lee/))).toBeVisible();
    expect(typing()).not.toBeInTheDocument();

    // When the turn completes, the chips go.
    expect(await untilFound(() => within(log).queryByText("Dr. Lee is free."))).toBeVisible();
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
    expect(await untilFound(() => within(log).queryByText(REPLIES.reset.text))).toBeVisible();
    expect(log).not.toHaveTextContent("I'm not able to");
  });

  it("announces the completed reply once, never a partial one", async () => {
    serveChunks([[{ type: "text_delta", text: REPLIES.plain.text }, done]]);
    await renderAtFakeTime(() => false);
    const announcements = recordAnnouncements();
    const conversation = log();
    const lastBubble = () => conversation.lastElementChild?.textContent ?? "";

    sendNow("Hi");
    await until(() => typing() === null);
    // One 16 ms tick per act(), so each partial render reaches the DOM (one long act commits only the
    // end). Tick until the bubble shows the whole reply (at most 300 ticks), then 1 s more, so a late
    // second announcement still lands in the recording: about 160 acts (94 + 63 locally) instead of a
    // fixed 300, which a loaded runner couldn't fit in the 5 s test timeout (#134).
    const bubbles = new Set<string>();
    const tick = async () => {
      await act(() => vi.advanceTimersByTimeAsync(16));
      bubbles.add(lastBubble());
    };
    for (let ticks = 0; ticks < 300 && lastBubble() !== REPLIES.plain.text; ticks += 1) await tick();
    for (let ticks = 0; ticks < 1000 / 16; ticks += 1) await tick();
    const announced = announcements.stop();
    expect(bubbles.size).toBeGreaterThan(10); // the reply was typed out in steps meanwhile
    expect(screen.queryByText(REPLIES.plain.text, { selector: "li" })).toBeVisible();
    expect(announced).toEqual([REPLIES.plain.text]);
  });

  it("announces a reply that repeats the previous announcement", async () => {
    serveEvents([delta("Sure."), done]);
    const { user, input, log } = renderChat();
    await within(log).findByText(SESSIONS.upcoming.greeting);
    const announcements = recordAnnouncements();
    await user.type(input, "One{Enter}");
    await until(() => within(log).queryAllByText("Sure.").length === 1);
    expect(within(log).getAllByText("Sure.")).toHaveLength(1);
    await user.type(input, "Two{Enter}");
    await until(() => within(log).queryAllByText("Sure.").length === 2);
    expect(within(log).getAllByText("Sure.")).toHaveLength(2);
    expect(announcements.stop()).toEqual(["Sure.", "Sure."]);
  });

  it("continues the conversation the first turn's done event started", async () => {
    serveEvents([{ type: "text_delta", text: "Sure." }, done]);
    const bodies = captureChatBodies();
    const { user, input, log } = renderChat();
    await user.type(input, "One{Enter}");
    await until(() => within(log).queryAllByText("Sure.").length === 1);
    expect(within(log).getAllByText("Sure.")).toHaveLength(1);
    await user.type(input, "Two{Enter}");
    await until(() => within(log).queryAllByText("Sure.").length === 2);
    expect(within(log).getAllByText("Sure.")).toHaveLength(2);
    const [first, second] = bodies as { conversationId?: string; clientMessageId: string }[];
    expect(first?.conversationId).toBeUndefined();
    expect(second?.conversationId).toBe(done.conversationId);
    expect(second?.clientMessageId).not.toBe(first?.clientMessageId);
  });

  it("sends the injected token", async () => {
    const seen: (string | null)[] = [];
    server.events.on("request:start", ({ request }) => seen.push(request.headers.get("Authorization")));
    const { user, input, log } = renderChat({
      api: createChatApi({ getToken: () => Promise.resolve("synthetic-id-token") }),
    });
    await user.type(input, "Hi{Enter}");
    await untilFound(() => within(log).queryByText(REPLIES.tools.text));
    expect(seen).toEqual(["synthetic-id-token", "synthetic-id-token"]);
  });

  it.each([
    ["an error event mid-stream", "mid_stream", "The assistant isn't available right now. Please try again."],
    ["a network failure", "network", "Something went wrong. Please try again."],
  ] as const)("ends the turn on %s and shows its message", async (_, chatFault, message) => {
    configureMockApi({ chatFault });
    const { user, input, sendButton, log } = renderChat();
    await user.type(input, "Hi{Enter}");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(message);
    expect(typing()).not.toBeInTheDocument();
    expect(within(log).getByText("Hi")).toBeVisible();
    await user.type(input, "again");
    expect(sendButton).toBeEnabled();
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
    const chips = await untilFound(() => screen.queryByRole("list", { name: "What the assistant is doing" }));
    await until(() => within(chips).queryAllByRole("listitem").length === 3);
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Checking A…", "Checking B…", "Checking A…"]);
    const items = within(chips).getAllByRole("listitem");
    expect(items.map((li) => li.classList.contains("chip--current"))).toEqual([false, false, true]);
    hold.open();
    await untilFound(() => within(log()).queryByText("Done."));
  });

  it("shows the typing indicator again when a text_reset drops every character, and no empty bubble", async () => {
    const hold = gate();
    serveEvents([delta("I can't"), { type: "text_reset", keepChars: 0 }, delta("Sure."), done], {
      2: hold.promise,
    });
    await renderPage();
    await sendFromPage("Hi");
    await until(() => typing() !== null);
    expect(typing()).toBeInTheDocument();
    // greeting + the patient's message; the reset bubble is gone rather than left empty
    expect(within(log()).getAllByRole("listitem")).toHaveLength(2);
    hold.open();
    expect(await untilFound(() => within(log()).queryByText("Sure."))).toBeVisible();
    expect(typing()).not.toBeInTheDocument();
  });

  it("marks the reply busy while it types", async () => {
    const hold = gate();
    serveEvents([delta("Part one. "), delta("Part two."), done], { 1: hold.promise });
    await renderPage();
    await sendFromPage("Hi");
    const bubble = await untilFound(() => within(log()).queryByText("Part one."));
    expect(bubble).toHaveAttribute("aria-busy", "true");
    hold.open();
    const final = await untilFound(() => within(log()).queryByText("Part one. Part two."));
    expect(final).not.toHaveAttribute("aria-busy");
  });

  it("keeps a completed reply when the connection fails after done", async () => {
    let failed: Promise<ChatStreamEvent[]> | undefined;
    const real = createChatApi();
    const api: ChatApi = {
      getSession: (signal) => real.getSession(signal),
      sendChat: (_request, onEvent) => {
        onEvent(delta("All set."));
        onEvent(done);
        failed = Promise.reject(new TypeError("connection reset"));
        return failed;
      },
    };
    render(<ChatPage api={api} reducedMotion={instant} />);
    await untilFound(() => within(log()).queryByText(SESSIONS.upcoming.greeting));
    await sendFromPage("Hi");
    expect(await within(log()).findByText("All set.")).toBeVisible();
    await act(() => failed?.catch(() => undefined));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(log()).getByText("All set.")).toBeVisible();
  });

  it("finishes typing a reply when the connection fails after done", async () => {
    const text = "a".repeat(300);
    let failed: Promise<ChatStreamEvent[]> | undefined;
    const real = createChatApi();
    const api: ChatApi = {
      getSession: (signal) => real.getSession(signal),
      sendChat: (_request, onEvent) => {
        onEvent(delta(text));
        onEvent(done);
        failed = Promise.reject(new TypeError("connection reset"));
        return failed;
      },
    };
    fakeTime();
    render(<ChatPage api={api} reducedMotion={() => false} />);
    await until(() => within(log()).queryByText(SESSIONS.upcoming.greeting) !== null);
    sendNow("Hi");
    // The connection fails while fake time stands still: none of the reply has been typed yet.
    await act(() => failed?.catch(() => undefined));
    expect(within(log()).queryByText(text)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(within(log()).getByText(text)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the error when the next message is sent", async () => {
    configureMockApi({ chatFault: "network" });
    await renderPage();
    await sendFromPage("Hi");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(GENERIC_ERROR);
    configureMockApi({ chatFault: "none" });
    await sendFromPage("Again");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
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

  it("scrolls the end of the conversation into view when a chip appears and when reply text appears", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const [chipSent, textSent, restSent] = [gate(), gate(), gate()];
    serveEvents([availability, delta("Part one. "), delta("Part two."), done], {
      0: chipSent.promise,
      1: textSent.promise,
      2: restSent.promise,
    });
    // The page scrolls in an effect after each render, so each check waits for the call. Each step
    // waits for its text with `until` (real I/O hops, no fixed timeout) rather than `findByText`'s fixed
    // timeout (set in src/test/setup.ts), which a loaded runner can spend before the gated stream gets
    // through (#122).
    try {
      await renderPage();
      // Forget the mount and greeting scrolls (the greeting is shown, so its scroll has run), so only
      // the sent message's own scroll satisfies the next wait; once it's seen and cleared, it can't
      // stand in for the chip's below.
      expect(within(log()).getByText(SESSIONS.upcoming.greeting)).toBeVisible();
      scrollIntoView.mockClear();
      await sendFromPage("Hi");
      await until(() => within(log()).queryByText("Hi") !== null);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" }));
      scrollIntoView.mockClear();

      // A chip: the turn's text is still empty and the messages haven't changed.
      chipSent.open();
      await until(() => screen.queryByText(TOOL_STATUS_LABELS.check_availability) !== null);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" }));
      scrollIntoView.mockClear();

      // The first text of the reply: the chips and the messages haven't changed.
      textSent.open();
      await until(() => within(log()).queryByText("Part one.") !== null);
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" }));

      restSent.open();
      await until(() => within(log()).queryByText("Part one. Part two.") !== null);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});
