/**
 * The error bubble and Retry (FR-015, FR-017, #27). Retry shows only for a retryable stream `error`
 * event or a network failure, and resends the same text, `clientMessageId` and `conversationId`.
 */
import { CLINIC, encodeStreamEvent } from "@sched/contracts";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NDJSON_CONTENT_TYPE } from "../mocks/handlers";
import { configureMockApi, server } from "../mocks/node";
import { REPLIES } from "../mocks/fixtures";
import { createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { captureChatBodies, instant, log, retryButton, typingIndicator as typing } from "./testUtils";
import { GENERIC_ERROR, SIGNED_OUT_ERROR, useChat } from "./useChat";

const UNAVAILABLE = "The assistant isn't available right now. Please try again.";
const BUSY = "Lots of people are chatting right now. Please try again in a moment.";

beforeEach(() => localStorage.clear());
afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
});

async function renderPage(props: { onUnauthorized?: () => void } = {}) {
  render(<ChatPage reducedMotion={instant} {...props} />);
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Message" });
  const sendMessage = (text: string) => user.type(input, `${text}{Enter}`);
  return { user, input, sendMessage };
}

describe("ChatPage: Retry (FR-015)", () => {
  it("resends the same text, clientMessageId and conversationId, once, without adding the message again", async () => {
    const bodies = captureChatBodies();
    let sessionCalls = 0;
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname === "/api/session") sessionCalls += 1;
    });
    const { user, input, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await within(log()).findByText(REPLIES.tools.text);

    configureMockApi({ chatFault: "unavailable" });
    await sendMessage("Book Wednesday");
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE);
    expect(within(log()).getByText("Book Wednesday")).toBeVisible();

    configureMockApi({ chatFault: "none" });
    await user.click(retryButton() as HTMLElement);
    await waitFor(() => expect(within(log()).getAllByText(REPLIES.tools.text)).toHaveLength(2));
    await waitFor(() => expect(bodies).toHaveLength(3));
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
    await within(log()).findByText(REPLIES.tools.text);
    configureMockApi({ chatFault: "network" });
    await sendMessage("Again");
    await screen.findByRole("alert");
    await user.click(retryButton() as HTMLElement);
    await waitFor(() => expect(bodies).toHaveLength(3));
    // The mock's done names a fresh conversation for the first turn; both later sends carry it.
    expect(bodies[0]?.conversationId).toBeUndefined();
    expect(bodies[1]?.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodies[2]?.conversationId).toBe(bodies[1]?.conversationId);
  });

  it("retries a failed first turn without a conversationId (the client has none yet)", async () => {
    const bodies = captureChatBodies();
    configureMockApi({ chatFault: "network" });
    const { user, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await screen.findByRole("alert");
    configureMockApi({ chatFault: "none" });
    await user.click(retryButton() as HTMLElement);
    await within(log()).findByText(REPLIES.tools.text);
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).not.toHaveProperty("conversationId");
  });

  it.each([
    ["a retryable error event mid-stream", "mid_stream", UNAVAILABLE],
    ["a retryable 429 (busy model quota)", "rate_limited", BUSY],
    ["a retryable 503", "unavailable", UNAVAILABLE],
    ["a network failure", "network", GENERIC_ERROR],
  ] as const)(
    "offers Retry on %s, beside the error and the patient's message",
    async (_, chatFault, message) => {
      configureMockApi({ chatFault });
      const { sendMessage } = await renderPage();
      await sendMessage("Hi");
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(typing()).not.toBeInTheDocument();
      expect(within(log()).getByText("Hi")).toBeVisible();
      // The error is a bubble in the conversation, with its Retry.
      const bubble = within(log()).getByText(message).closest("li");
      expect(bubble).not.toBeNull();
      expect(within(bubble as HTMLElement).getByRole("button", { name: "Retry" })).toBeVisible();
    },
  );

  it("shows the daily cap's message, with the front desk's number and hours, and no Retry (FR-017)", async () => {
    configureMockApi({ chatFault: "daily_cap" });
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(CLINIC.phone);
    expect(alert).toHaveTextContent(CLINIC.hours);
    expect(retryButton()).not.toBeInTheDocument();
    expect(within(log()).getByText("Hi")).toBeVisible();
  });

  it.each([
    [
      "an HTTP error without an error event (a 502 from the gateway)",
      () => new HttpResponse("Bad Gateway", { status: 502 }),
    ],
    [
      "a stream that breaks the contract",
      () => new HttpResponse('{"type":"nope"}\n', { headers: { "Content-Type": NDJSON_CONTENT_TYPE } }),
    ],
  ])("shows the generic error without Retry for %s", async (_, respond) => {
    server.use(http.post("/api/chat", respond));
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    expect(await screen.findByRole("alert")).toHaveTextContent(GENERIC_ERROR);
    expect(retryButton()).not.toBeInTheDocument();
    expect(within(log()).getByText("Hi")).toBeVisible();
  });

  it("on API Gateway's 401 (no event body), says the sign-in has ended, without Retry, and hands over to sign-in", async () => {
    configureMockApi({ chatFault: "unauthorized" });
    const onUnauthorized = vi.fn();
    const { sendMessage } = await renderPage({ onUnauthorized });
    await sendMessage("Hi");
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGNED_OUT_ERROR);
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
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGNED_OUT_ERROR);
    expect(retryButton()).not.toBeInTheDocument();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("drops Retry when the patient sends a new message instead, which gets its own clientMessageId", async () => {
    const bodies = captureChatBodies();
    configureMockApi({ chatFault: "network" });
    const { sendMessage } = await renderPage();
    await sendMessage("Hi");
    await screen.findByRole("alert");
    configureMockApi({ chatFault: "none" });
    await sendMessage("Hello?");
    await within(log()).findByText(REPLIES.tools.text);
    expect(retryButton()).not.toBeInTheDocument();
    expect(within(log()).getByText("Hi")).toBeVisible();
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]?.clientMessageId).not.toBe(bodies[0]?.clientMessageId);
  });

  it("runs one retry when Retry is called twice before re-rendering", async () => {
    const bodies = captureChatBodies();
    configureMockApi({ chatFault: "network" });
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    act(() => {
      result.current.send("Hi");
    });
    await waitFor(() => expect(result.current.error?.retryable).toBe(true));
    configureMockApi({ chatFault: "none" });
    act(() => {
      result.current.retry();
      result.current.retry();
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(result.current.responding).toBe(false);
  });

  it("does nothing on Retry when there is no error", async () => {
    const { result } = renderHook(() => useChat(createChatApi(), { reducedMotion: instant }));
    await waitFor(() => expect(result.current.greeting.state).toBe("ready"));
    act(() => result.current.retry());
    // A turn would be under way, or the greeting loading again, as soon as `act` returns.
    expect(result.current.responding).toBe(false);
    expect(result.current.greeting.state).toBe("ready");
  });

  it("keeps Retry keyboard-operable: Enter on the focused button retries", async () => {
    configureMockApi({ chatFault: "unavailable" });
    const { user, sendMessage } = await renderPage();
    await sendMessage("Hi");
    await screen.findByRole("alert");
    configureMockApi({ chatFault: "none" });
    const button = retryButton() as HTMLElement;
    button.focus();
    await user.keyboard("{Enter}");
    await within(log()).findByText(REPLIES.tools.text);
  });
});
