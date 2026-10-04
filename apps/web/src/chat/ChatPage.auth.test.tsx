/**
 * The login-session rule through the app (FR-014, #27): the chat page takes the patient's `sub` from
 * the auth context, and `AuthProvider` ends the login session on sign-in, sign-out and when the
 * sign-in ends. A 401 signs the patient out, which routes to sign-in.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appRoutes } from "../app/routes";
import type { AuthService } from "../auth/authService";
import { fakeAuthService, fakeSub } from "../auth/testing";
import { REPLIES, RESTORE_CONVERSATION_ID, SESSIONS } from "../mocks/fixtures";
import { configureMockApi } from "../mocks/node";
import { LOGIN_SESSION_STORAGE_KEY, readLoginSession, writeLoginSession } from "./loginSession";

const MARIA = { username: "maria.santos", sub: fakeSub("maria.santos") };
const RESTORED_QUESTION = SESSIONS.restore.messages[0]?.text ?? "";

beforeEach(() => {
  localStorage.clear();
  // The routed page reads reduced motion from the media query, which jsdom lacks: reply instantly.
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
});
afterEach(() => vi.unstubAllGlobals());

function renderApp(path: string, auth: AuthService) {
  const router = createMemoryRouter(appRoutes(undefined, auth), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const conversation = () => screen.getByRole("list", { name: "Conversation" });
const stored = () => localStorage.getItem(LOGIN_SESSION_STORAGE_KEY);

describe("ChatPage in the app: the login session", () => {
  it("restores for the signed-in patient's sub", async () => {
    writeLoginSession({ sub: MARIA.sub, conversationId: RESTORE_CONVERSATION_ID });
    configureMockApi({ session: "restore" });
    renderApp("/chat", fakeAuthService(MARIA));
    expect(await screen.findByText(RESTORED_QUESTION)).toBeVisible();
  });

  it("remembers the conversation a turn starts under the signed-in patient's sub", async () => {
    renderApp("/chat", fakeAuthService(MARIA));
    const input = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.setup().type(input, "Hi{Enter}");
    await within(conversation()).findByText(REPLIES.tools.text);
    expect(readLoginSession()?.sub).toBe(MARIA.sub);
  });

  it("clears it on sign-out", async () => {
    writeLoginSession({ sub: MARIA.sub, conversationId: RESTORE_CONVERSATION_ID });
    const router = renderApp("/chat", fakeAuthService(MARIA));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    await waitFor(() => expect(stored()).toBeNull());
  });

  it("clears it when the sign-in ends (Amplify's signedOut or tokenRefresh_failure)", async () => {
    writeLoginSession({ sub: MARIA.sub, conversationId: RESTORE_CONVERSATION_ID });
    const auth = fakeAuthService(MARIA);
    renderApp("/chat", auth);
    await screen.findByRole("heading", { name: "Chat" });
    expect(stored()).not.toBeNull();
    auth.emitChange();
    await waitFor(() => expect(stored()).toBeNull());
  });

  it("clears one left from an earlier sign-in when the patient signs in again", async () => {
    // The earlier sign-in ended while no tab was open, so nothing cleared it then.
    writeLoginSession({ sub: MARIA.sub, conversationId: RESTORE_CONVERSATION_ID });
    configureMockApi({ session: "restore" });
    renderApp("/login", fakeAuthService());
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Username"), MARIA.username);
    await user.type(screen.getByLabelText("Password"), "synthetic-pass{Enter}");
    await within(await screen.findByRole("list", { name: "Conversation" })).findByText(
      SESSIONS.restore.greeting,
    );
    expect(stored()).toBeNull();
    expect(screen.queryByText(RESTORED_QUESTION)).not.toBeInTheDocument();
  });

  it("signs the patient out, to /login, when the session call answers 401", async () => {
    configureMockApi({ sessionFault: "unauthorized" });
    const auth = fakeAuthService(MARIA);
    const router = renderApp("/chat", auth);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
