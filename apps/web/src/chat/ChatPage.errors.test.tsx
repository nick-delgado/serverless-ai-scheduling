/**
 * The error bubble and Retry (FR-015, FR-017, #27, #138). Retry shows only for a retryable stream
 * `error` event, a network failure, a 5xx without an event, or a stream that ends without `done` or
 * `error`, and resends the same text, `clientMessageId` and `conversationId`.
 */
import { CLINIC, type ChatStreamEvent, encodeStreamEvent } from "@sched/contracts";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NDJSON_CONTENT_TYPE } from "../mocks/handlers";
import { configureMockApi, server } from "../mocks/node";
import { REPLIES, SESSIONS } from "../mocks/fixtures";
import { type ChatApi, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { readLoginSession } from "./loginSession";
import { ChatProtocolError } from "./streamClient";
import {
  captureChatBodies,
  doneEvent,
  fakeTime,
  instant,
  log,
  retryButton,
  sendNow,
  typingIndicator as typing,
  until,
  untilFound,
} from "./testUtils";
import { GENERIC_ERROR, SIGNED_OUT_ERROR, useChat } from "./useChat";

const UNAVAILABLE = "The assistant isn't available right now. Please try again.";
const BUSY = "Lots of people are chatting right now. Please try again in a moment.";

const delta = (text: string): ChatStreamEvent => ({ type: "text_delta", text });

/** A 200 NDJSON body with exactly these events, which then ends. */
const ndjson = (events: ChatStreamEvent[]) =>
  new HttpResponse(events.map(encodeStreamEvent).join(""), {
    headers: { "Content-Type": NDJSON_CONTENT_TYPE },
  });

// The waits on the mock API's I/O use `until`, which has no fixed time limit and can outlast the 5 s
// default on a loaded runner: give each test room for it (testUtils.ts, #134).
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => localStorage.clear());
afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function renderPage(props: { onUnauthorized?: () => void; sub?: string } = {}) {
  render(<ChatPage reducedMotion={instant} {...props} />);
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Message" });
  const sendMessage = (text: string) => user.type(input, `${text}{Enter}`);
  return { user, input, sendMessage };
}

describe("ChatPage: Retry after a first turn named its conversation (#160)", () => {
  const NAMED = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const SUB = "c2a4e6b8-1d3f-4a5b-8c7d-9e0f1a2b3c4d";

  /** A 200 stream with the `conversation` line, then `end` (close it, or fail the read), once. */
  function nameThen(end: "close" | "error") {
    const named: ChatStreamEvent = { type: "conversation", conversationId: NAMED };
    if (end === "close") {
      server.use(http.post("/api/chat", () => ndjson([named]), { once: true }));
      return;
    }
    server.use(
      http.post(
        "/api/chat",
        () => {
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new TextEncoder().encode(encodeStreamEvent(named)));
                return;
              }
              // fetch reads ahead, and an error drops what it buffered: fail the read only once the
              // page has handled the line (it wrote the login session), as a drop mid-read would.
              await until(() => readLoginSession()?.conversationId === NAMED);
              controller.error(new TypeError("network error"));
            },
          });
          return new HttpResponse(body, { headers: { "Content-Type": NDJSON_CONTENT_TYPE } });
        },
        { once: true },
      ),
    );
  }

  it.each([
    ["the stream is cut after it", "close"],
    ["the connection drops mid-read", "error"],
  ] as const)("when %s, Retry resends with that conversationId", async (_, end) => {
    const bodies = captureChatBodies();
    nameThen(end);
    const { user, sendMessage } = await renderPage({ sub: SUB });
    await sendMessage("Hi");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(GENERIC_ERROR);
    await user.click(retryButton() as HTMLElement);
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
    await until(() => bodies.length === 2);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("conversationId");
    expect(bodies[1]).toEqual({ ...bodies[0], conversationId: NAMED });
  });

  it("resends without a conversationId after a bare 5xx before any byte (a gateway's own)", async () => {
    const bodies = captureChatBodies();
    server.use(
      http.post("/api/chat", () => HttpResponse.text("Bad gateway", { status: 502 }), { once: true }),
    );
    const { user, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await untilFound(() => screen.queryByRole("alert"));
    await user.click(retryButton() as HTMLElement);
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
    await until(() => bodies.length === 2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).not.toHaveProperty("conversationId");
  });
});

describe("ChatPage: Retry (FR-015)", () => {
  it("resends the same text, clientMessageId and conversationId, once, without adding the message again", async () => {
    const bodies = captureChatBodies();
    let sessionCalls = 0;
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === "/api/session") sessionCalls += 1;
    });
    const { user, input, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));

    configureMockApi({ chatFault: "unavailable" });
    await sendMessage("Book Wednesday");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(UNAVAILABLE);
    expect(within(log()).getByText("Book Wednesday")).toBeVisible();

    configureMockApi({ chatFault: "none" });
    await user.click(retryButton() as HTMLElement);
    await until(() => within(log()).queryAllByText(REPLIES.tools.text).length === 2);
    expect(within(log()).getAllByText(REPLIES.tools.text)).toHaveLength(2);
    await until(() => bodies.length === 3);
    expect(bodies).toHaveLength(3);
    const [, failed, retried] = bodies;
    expect(failed?.conversationId).toBeDefined();
    expect(retried).toEqual(failed);
    expect(within(log()).getAllByText("Book Wednesday")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(retryButton()).not.toBeInTheDocument();
    // A turn's Retry doesn't load the session again.
    expect(sessionCalls).toBe(1);
    // Retry removed its own button: focus goes back to the message box.
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("sends the conversationId from the last done, which the retried turn keeps", async () => {
    const bodies = captureChatBodies();
    const { user, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
    configureMockApi({ chatFault: "network" });
    await sendMessage("Again");
    await untilFound(() => screen.queryByRole("alert"));
    await user.click(retryButton() as HTMLElement);
    await until(() => bodies.length === 3);
    expect(bodies).toHaveLength(3);
    // The mock's done names a fresh conversation for the first turn; both later sends carry it.
    expect(bodies[0]?.conversationId).toBeUndefined();
    expect(bodies[1]?.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[2]?.conversationId).toBe(bodies[1]?.conversationId);
  });

  it("retries a first turn that failed before any byte without a conversationId (the client has none yet)", async () => {
    const bodies = captureChatBodies();
    configureMockApi({ chatFault: "network" });
    const { user, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await untilFound(() => screen.queryByRole("alert"));
    configureMockApi({ chatFault: "none" });
    await user.click(retryButton() as HTMLElement);
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
    await until(() => bodies.length === 2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).not.toHaveProperty("conversationId");
  });

  /** The page shows `message` in an error bubble beside `sent`, with its Retry, and no typing indicator. */
  async function expectRetryBubble(message: string, sent: string) {
    const alert = await untilFound(() => screen.queryByRole("alert"));
    expect(alert).toHaveTextContent(message);
    expect(typing()).not.toBeInTheDocument();
    expect(within(log()).getByText(sent)).toBeVisible();
    // The error is a bubble in the conversation, with its Retry.
    const bubble = within(log()).getByText(message).closest("li");
    expect(bubble).not.toBeNull();
    expect(within(bubble as HTMLElement).getByRole("button", { name: "Retry" })).toBeVisible();
  }

  // A first turn: the mock names the conversation, so its agent faults answer 200 (#160).
  it.each([
    ["a retryable error event mid-stream", "mid_stream", UNAVAILABLE],
    ["a 200 with a retryable RATE_LIMITED event on a first turn", "rate_limited", BUSY],
    ["a 200 with a retryable AGENT_UNAVAILABLE event on a first turn", "unavailable", UNAVAILABLE],
    ["a network failure", "network", GENERIC_ERROR],
  ] as const)(
    "offers Retry on %s, beside the error and the patient's message",
    async (_, chatFault, message) => {
      configureMockApi({ chatFault });
      const { sendMessage } = await renderPage();
      await sendMessage("Hi");
      await expectRetryBubble(message, "Hi");
    },
  );

  // A continued conversation, which the mock still answers 429/503 (#160).
  it.each([
    ["a retryable 429 (busy model quota)", "rate_limited", 429, BUSY],
    ["a retryable 503", "unavailable", 503, UNAVAILABLE],
  ] as const)(
    "offers Retry on %s in a continued conversation, beside the error and the patient's message",
    async (_, chatFault, status, message) => {
      const statuses: number[] = [];
      server.events.on("response:mocked", ({ request, response }) => {
        if (new URL(request.url).pathname === "/api/chat") statuses.push(response.status);
      });
      const { sendMessage } = await renderPage();
      await sendMessage("Hi");
      await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
      configureMockApi({ chatFault });
      await sendMessage("Book Wednesday");
      await expectRetryBubble(message, "Book Wednesday");
      expect(statuses).toEqual([200, status]);
    },
  );

  it("shows the daily cap's message, with the front desk's number and hours, and no Retry (FR-017)", async () => {
    configureMockApi({ chatFault: "daily_cap" });
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    const alert = await untilFound(() => screen.queryByRole("alert"));
    expect(alert).toHaveTextContent(CLINIC.phone);
    expect(alert).toHaveTextContent(CLINIC.hours);
    expect(retryButton()).not.toBeInTheDocument();
    expect(within(log()).getByText("Hi")).toBeVisible();
  });

  it.each([
    ["a 500 without an error event", () => new HttpResponse("Internal Server Error", { status: 500 })],
    ["a 502 from the gateway", () => new HttpResponse("Bad Gateway", { status: 502 })],
    ["a 503 without an error event", () => new HttpResponse("Service Unavailable", { status: 503 })],
    ["a 504 from CloudFront", () => new HttpResponse("Gateway Timeout", { status: 504 })],
    ["a stream that ends before done or error", () => ndjson([delta("Let me check")])],
    ["an empty 200 body", () => ndjson([])],
  ])(
    "offers Retry on %s, which resends the same text, clientMessageId and conversationId (#138)",
    async (_, respond) => {
      const bodies = captureChatBodies();
      const { user, sendMessage } = await renderPage();
      await sendMessage("Hi");
      await untilFound(() => within(log()).queryByText(REPLIES.tools.text));

      // Only the next send fails; the Retry after it reaches the mock API again.
      server.use(http.post("/api/chat", respond, { once: true }));
      await sendMessage("Book Wednesday");
      const alert = await untilFound(() => screen.queryByRole("alert"));
      expect(alert).toHaveTextContent(GENERIC_ERROR);
      const bubble = within(log()).getByText(GENERIC_ERROR).closest("li");
      expect(within(bubble as HTMLElement).getByRole("button", { name: "Retry" })).toBeVisible();
      expect(within(log()).getByText("Book Wednesday")).toBeVisible();

      await user.click(retryButton() as HTMLElement);
      await until(() => within(log()).queryAllByText(REPLIES.tools.text).length === 2);
      expect(within(log()).getAllByText(REPLIES.tools.text)).toHaveLength(2);
      await until(() => bodies.length === 3);
      expect(bodies).toHaveLength(3);
      const [, failed, retried] = bodies;
      expect(failed?.conversationId).toBeDefined();
      expect(retried).toEqual(failed);
      expect(within(log()).getAllByText("Book Wednesday")).toHaveLength(1);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["a 400 without an error event", () => new HttpResponse("Bad Request", { status: 400 })],
    [
      "a 429 without an error event (API Gateway's throttle)",
      () => new HttpResponse("Too Many Requests", { status: 429 }),
    ],
    ["a 499 without an error event", () => new HttpResponse("", { status: 499 })],
    [
      "a stream that breaks the contract",
      () => new HttpResponse('{"type":"nope"}\n', { headers: { "Content-Type": NDJSON_CONTENT_TYPE } }),
    ],
    [
      "a stream whose last line is cut mid-way",
      () =>
        new HttpResponse(`${encodeStreamEvent(delta("Let me"))}{"type":"text_del`, {
          headers: { "Content-Type": NDJSON_CONTENT_TYPE },
        }),
    ],
  ])("shows the generic error without Retry for %s", async (_, respond) => {
    server.use(http.post("/api/chat", respond));
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(GENERIC_ERROR);
    expect(retryButton()).not.toBeInTheDocument();
    expect(within(log()).getByText("Hi")).toBeVisible();
  });

  it("shows a 500's non-retryable INTERNAL event's message, without Retry (the asymmetry at 500)", async () => {
    const event = {
      type: "error",
      code: "INTERNAL",
      message: "Something went wrong on our side.",
      retryable: false,
    } as const;
    server.use(
      http.post(
        "/api/chat",
        () =>
          new HttpResponse(encodeStreamEvent(event), {
            status: 500,
            headers: { "Content-Type": NDJSON_CONTENT_TYPE },
          }),
      ),
    );
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(event.message);
    expect(retryButton()).not.toBeInTheDocument();
  });

  it("keeps the reply, with no error, when the stream sends an event after done", async () => {
    const reply = "All set for Wednesday at 10 AM.";
    server.use(http.post("/api/chat", () => ndjson([delta(reply), doneEvent(), delta(" More.")])));
    let sent: Promise<ChatStreamEvent[]> | undefined;
    const real = createChatApi();
    const api: ChatApi = {
      getSession: (signal) => real.getSession(signal),
      sendChat: (request, onEvent, signal) => {
        sent = real.sendChat(request, onEvent, signal);
        return sent;
      },
    };
    fakeTime();
    render(<ChatPage api={api} reducedMotion={() => false} />);
    await until(() => within(log()).queryByText(SESSIONS.upcoming.greeting) !== null);
    sendNow("Hi");
    // The stream rejects while fake time stands still, so the protocol error lands before the reply has typed.
    await act(() => sent?.catch(() => undefined));
    await expect(sent).rejects.toBeInstanceOf(ChatProtocolError);
    expect(within(log()).queryByText(reply)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(within(log()).getByText(reply)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(retryButton()).not.toBeInTheDocument();
  });

  it.each([
    ["sends more (a protocol error)", () => new ChatProtocolError("An event came after the terminal one.")],
    ["drops (a network failure)", () => new TypeError("connection reset")],
  ])("keeps a retryable error event's message and Retry when the stream then %s", async (_, failure) => {
    const message = "The assistant hit a snag. Please try again.";
    let failed: Promise<ChatStreamEvent[]> | undefined;
    const real = createChatApi();
    const api: ChatApi = {
      getSession: (signal) => real.getSession(signal),
      sendChat: (_request, onEvent) => {
        onEvent({ type: "error", code: "AGENT_UNAVAILABLE", message, retryable: true });
        failed = Promise.reject(failure());
        return failed;
      },
    };
    render(<ChatPage api={api} reducedMotion={instant} />);
    await untilFound(() => within(log()).queryByText(SESSIONS.upcoming.greeting));
    sendNow("Hi");
    await act(() => failed?.catch(() => undefined));
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert")).not.toHaveTextContent(GENERIC_ERROR);
    expect(retryButton()).toBeInTheDocument();
  });

  it("on API Gateway's 401 (no event body), says the sign-in has ended, without Retry, and hands over to sign-in", async () => {
    configureMockApi({ chatFault: "unauthorized" });
    const onUnauthorized = vi.fn();
    const { sendMessage } = await renderPage({ onUnauthorized });
    await sendMessage("Hi");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(SIGNED_OUT_ERROR);
    expect(retryButton()).not.toBeInTheDocument();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("on the chat handler's 401 (an UNAUTHORIZED error event), says the sign-in has ended, without Retry, and hands over to sign-in", async () => {
    const event = {
      type: "error",
      code: "UNAUTHORIZED",
      message: "Please sign in again.",
      retryable: false,
    } as const;
    server.use(
      http.post(
        "/api/chat",
        () =>
          new HttpResponse(encodeStreamEvent(event), {
            status: 401,
            headers: { "Content-Type": NDJSON_CONTENT_TYPE },
          }),
      ),
    );
    const onUnauthorized = vi.fn();
    const { sendMessage } = await renderPage({ onUnauthorized });
    await sendMessage("Hi");
    expect(await untilFound(() => screen.queryByRole("alert"))).toHaveTextContent(SIGNED_OUT_ERROR);
    expect(retryButton()).not.toBeInTheDocument();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("drops Retry when the patient sends a new message instead, which gets its own clientMessageId", async () => {
    const bodies = captureChatBodies();
    configureMockApi({ chatFault: "network" });
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    await untilFound(() => screen.queryByRole("alert"));
    configureMockApi({ chatFault: "none" });
    await sendMessage("Hello?");
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
    expect(retryButton()).not.toBeInTheDocument();
    expect(within(log()).getByText("Hi")).toBeVisible();
    await until(() => bodies.length === 2);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  });

  it("runs one retry when Retry is called twice before re-rendering", async () => {
    const bodies = captureChatBodies();
    configureMockApi({ chatFault: "network" });
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    act(() => {
      result.current.send("Hi");
    });
    await until(() => result.current.error?.retryable === true);
    expect(result.current.error?.retryable).toBe(true);
    configureMockApi({ chatFault: "none" });
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    await until(() => result.current.messages.length === 2);
    expect(result.current.messages).toHaveLength(2);
    await until(() => bodies.length === 2);
    expect(bodies).toHaveLength(2);
    expect(result.current.responding).toBe(false);
  });

  it("does nothing on Retry when there is no error", async () => {
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    await until(() => result.current.greeting.state === "ready");
    expect(result.current.greeting.state).toBe("ready");
    act(() => result.current.retry());
    // A turn would be under way, or the greeting loading again, as soon as `act` returns.
    expect(result.current.responding).toBe(false);
    expect(result.current.greeting.state).toBe("ready");
  });

  it("keeps Retry keyboard-operable: Enter on the focused button retries", async () => {
    configureMockApi({ chatFault: "unavailable" });
    const { user, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await untilFound(() => screen.queryByRole("alert"));
    configureMockApi({ chatFault: "none" });
    const button = retryButton() as HTMLElement;
    button.focus();
    await user.keyboard("{Enter}");
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
  });
});
