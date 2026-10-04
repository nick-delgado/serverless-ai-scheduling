/**
 * Restoring the conversation on load (FR-014, #27) and a failed session call. The login-session rule
 * (`loginSession.ts`): only the conversation this login session has been using, for the same `sub`,
 * comes back; anything else starts the chat empty, and the next turn starts a new conversation.
 */
import { type SessionResponse } from "@sched/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REPLIES, RESTORE_CONVERSATION_ID, SESSIONS } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { type ChatApi, ChatHttpError, createChatApi } from "./api";
import { ChatPage } from "./ChatPage";
import { readLoginSession, writeLoginSession } from "./loginSession";
import {
  captureChatBodies,
  doneEvent,
  gate,
  instant,
  log,
  retryButton,
  serveEvents,
  typingIndicator as typing,
} from "./testUtils";
import { FALLBACK_GREETING, SESSION_ERROR, SIGNED_OUT_ERROR } from "./useChat";

const SUB = "sub-maria.santos";
const OTHER_CONVERSATION = "7d4c2b1a-9e8f-4a6b-8c5d-3e2f1a0b9c8d";
const [RESTORED_QUESTION, RESTORED_ANSWER] = SESSIONS.restore.messages.map((message) => message.text);

beforeEach(() => localStorage.clear());
afterEach(() => {
  server.events.removeAllListeners();
  vi.restoreAllMocks();
});

function renderPage(props: { sub?: string; onUnauthorized?: () => void; api?: ChatApi } = {}) {
  render(<ChatPage reducedMotion={instant} {...props} />);
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Message" });
  return { user, input, sendMessage: (text: string) => user.type(input, `${text}{Enter}`) };
}

const restoredShown = () => within(log()).queryByText(RESTORED_QUESTION ?? "") !== null;

describe("ChatPage: restore (FR-014)", () => {
  it("restores the conversation this login session has been using, in order, and continues it", async () => {
    writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    configureMockApi({ session: "restore" });
    const bodies = captureChatBodies();
    const { sendMessage } = renderPage({ sub: SUB });
    await within(log()).findByText(SESSIONS.restore.greeting);
    expect(
      within(log())
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([SESSIONS.restore.greeting, `You: ${RESTORED_QUESTION ?? ""}`, RESTORED_ANSWER]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await sendMessage("Yes, move it");
    await within(log()).findByText(REPLIES.tools.text);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]?.conversationId).toBe(RESTORE_CONVERSATION_ID);
    expect(readLoginSession()).toEqual({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
  });

  it.each([
    ["nothing is stored (a new sign-in)", undefined, SUB],
    [
      "this login session has been using another conversation",
      { sub: SUB, conversationId: OTHER_CONVERSATION },
      SUB,
    ],
    [
      "the stored login session is another patient's",
      { sub: "sub-someone.else", conversationId: RESTORE_CONVERSATION_ID },
      SUB,
    ],
  ])(
    "starts empty when %s, and the next turn starts a new conversation it remembers",
    async (_, stored, sub) => {
      if (stored) writeLoginSession(stored);
      configureMockApi({ session: "restore" });
      const bodies = captureChatBodies();
      const { sendMessage } = renderPage({ sub });
      await within(log()).findByText(SESSIONS.restore.greeting);
      expect(restoredShown()).toBe(false);
      expect(within(log()).getAllByRole("listitem")).toHaveLength(1);

      await sendMessage("Hi");
      await within(log()).findByText(REPLIES.tools.text);
      await waitFor(() => expect(bodies).toHaveLength(1));
      expect(bodies[0]).not.toHaveProperty("conversationId");
      const remembered = readLoginSession();
      expect(remembered?.sub).toBe(SUB);
      expect(remembered?.conversationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(remembered?.conversationId).not.toBe(RESTORE_CONVERSATION_ID);
    },
  );

  it("restores nothing and remembers nothing without a signed-in sub", async () => {
    writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    configureMockApi({ session: "restore" });
    const { sendMessage } = renderPage();
    await within(log()).findByText(SESSIONS.restore.greeting);
    expect(restoredShown()).toBe(false);
    await sendMessage("Hi");
    await within(log()).findByText(REPLIES.tools.text);
    expect(readLoginSession()).toEqual({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
  });

  it("doesn't restore over a turn the patient sent before the session call answered", async () => {
    writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    const sessionHold = gate();
    server.use(
      http.post("/api/session", async () => {
        await sessionHold.promise;
        return HttpResponse.json(SESSIONS.restore);
      }),
    );
    // The turn is still running when the session answers, so its done hasn't changed the store yet.
    const turnHold = gate();
    serveEvents([{ type: "text_delta", text: "Moving it." }, doneEvent()], { 1: turnHold.promise });
    const { sendMessage } = renderPage({ sub: SUB });
    await sendMessage("Hi");
    await within(log()).findByText("Moving it.");
    sessionHold.open();
    await within(log()).findByText(SESSIONS.restore.greeting);
    expect(restoredShown()).toBe(false);
    expect(within(log()).getByText("Hi")).toBeVisible();
    turnHold.open();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled());
    await waitFor(() => expect(within(log()).getByText("Hi")).toBeVisible());
    expect(restoredShown()).toBe(false);
  });

  it("applies the sub the page has when the session call answers, not when it started", async () => {
    writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    const hold = gate();
    server.use(
      http.post("/api/session", async () => {
        await hold.promise;
        return HttpResponse.json(SESSIONS.restore);
      }),
    );
    const { rerender } = render(<ChatPage reducedMotion={instant} />);
    rerender(<ChatPage reducedMotion={instant} sub={SUB} />);
    hold.open();
    await within(log()).findByText(SESSIONS.restore.greeting);
    expect(restoredShown()).toBe(true);
  });
});

describe("ChatPage: a failed session call", () => {
  it.each([
    ["a 500", () => configureMockApi({ sessionFault: "internal" })],
    ["a network failure", () => configureMockApi({ sessionFault: "network" })],
    [
      "a body that isn't a SessionResponse",
      () => server.use(http.post("/api/session", () => HttpResponse.json({ greeting: "Hi" }))),
    ],
  ])("shows %s as an error with Retry, under the fallback greeting", async (_, inject) => {
    inject();
    renderPage({ sub: SUB });
    expect(await screen.findByRole("alert")).toHaveTextContent(SESSION_ERROR);
    expect(within(log()).getByText(FALLBACK_GREETING)).toBeVisible();
    expect(retryButton()).toBeVisible();
  });

  it("loads the session again on Retry, with the typing indicator meanwhile, and restores", async () => {
    writeLoginSession({ sub: SUB, conversationId: RESTORE_CONVERSATION_ID });
    configureMockApi({ sessionFault: "internal" });
    const { user, input } = renderPage({ sub: SUB });
    await screen.findByRole("alert");

    const hold = gate();
    server.use(
      http.post("/api/session", async () => {
        await hold.promise;
        return HttpResponse.json(SESSIONS.restore);
      }),
    );
    await user.click(retryButton() as HTMLElement);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(typing()).toBeInTheDocument();
    expect(within(log()).queryByText(FALLBACK_GREETING)).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());

    hold.open();
    await within(log()).findByText(SESSIONS.restore.greeting);
    expect(restoredShown()).toBe(true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("on a 401, says the sign-in has ended, without Retry, and hands over to sign-in", async () => {
    configureMockApi({ sessionFault: "unauthorized" });
    const onUnauthorized = vi.fn();
    renderPage({ sub: SUB, onUnauthorized });
    expect(await screen.findByRole("alert")).toHaveTextContent(SIGNED_OUT_ERROR);
    expect(retryButton()).not.toBeInTheDocument();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 500", 500],
    ["a 401", 401],
  ])("doesn't report %s that comes after the patient has sent a message", async (_, status) => {
    const hold = gate();
    server.use(
      http.post("/api/session", async () => {
        await hold.promise;
        return HttpResponse.json({ message: "nope" }, { status });
      }),
    );
    const onUnauthorized = vi.fn();
    const { sendMessage } = renderPage({ sub: SUB, onUnauthorized });
    await sendMessage("Hi");
    await within(log()).findByText(REPLIES.tools.text);
    hold.open();
    await within(log()).findByText(FALLBACK_GREETING);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("ignores the aborted first call of a strict-mode remount", async () => {
    const real = createChatApi();
    let calls = 0;
    const api: ChatApi = {
      getSession(signal) {
        calls += 1;
        if (calls === 1) {
          // Rejects (as a 401) only after the second call has answered.
          return new Promise<SessionResponse>((_, reject) =>
            signal?.addEventListener("abort", () => setTimeout(() => reject(new ChatHttpError(401)), 30)),
          );
        }
        return real.getSession(signal);
      },
      sendChat: (...args) => real.sendChat(...args),
    };
    const onUnauthorized = vi.fn();
    render(
      <StrictMode>
        <ChatPage api={api} reducedMotion={instant} sub={SUB} onUnauthorized={onUnauthorized} />
      </StrictMode>,
    );
    await within(log()).findByText(SESSIONS.upcoming.greeting);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
