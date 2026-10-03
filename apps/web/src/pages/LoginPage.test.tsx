/**
 * Login, the /chat guard and sign-out (S1-02, #25; FR-001..FR-003, NFR-005). Most tests run the
 * whole app against the Cognito mock (real Amplify, real SRP); the ones about timing and call
 * counts use a fake auth service they control.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appRoutes } from "../app/routes";
import type { AuthService, SignInResult } from "../auth/authService";
import { SignOutButton } from "../auth/SignOutButton";
import { getIdToken } from "../auth/session";
import { fakeAuthService } from "../auth/testing";
import { configureCognitoMock, expireCognitoSessions, resetCognitoMock } from "../mocks/cognito";
import { MOCK_PASSWORD } from "../mocks/cognitoUsers";
import { LOGIN_ERRORS } from "./LoginPage";

// Each sign-in runs SRP's 3072-bit math on both sides (~0.2 s alone); allow for a busy CI machine.
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => localStorage.clear());
afterEach(() => {
  resetCognitoMock();
  vi.restoreAllMocks();
});

/** Render the app at `path`, with the real (mock-backed) auth service unless `auth` is given. */
function renderApp(path: string, auth?: AuthService) {
  const router = createMemoryRouter(appRoutes(undefined, auth), { initialEntries: [path] });
  const view = render(<RouterProvider router={router} />);
  return { router, unmount: view.unmount };
}

const usernameField = () => screen.getByLabelText("Username");
const passwordField = () => screen.getByLabelText("Password");
const submitButton = () => screen.getByRole("button", { name: /Sign(ing)? in/ });

async function signInThroughForm(username: string, password: string) {
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "Sign in" });
  await user.type(usernameField(), username);
  await user.type(passwordField(), `${password}{Enter}`);
  return user;
}

describe("login form (FR-001)", () => {
  it("labels its fields for password managers and screen readers, in tab order, with no sign-up link", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(usernameField()).toHaveAttribute("autocomplete", "username");
    expect(passwordField()).toHaveAttribute("type", "password");
    expect(passwordField()).toHaveAttribute("autocomplete", "current-password");
    expect(screen.queryByRole("link", { name: /sign up|register|create/i })).toBeNull();
    // Nothing to describe until there's an error, and nothing marked invalid.
    expect(usernameField()).not.toHaveAttribute("aria-describedby");
    expect(passwordField()).not.toHaveAttribute("aria-describedby");
    expect(usernameField()).not.toHaveAttribute("aria-invalid");
    await user.tab(); // skip link
    await user.tab();
    expect(usernameField()).toHaveFocus();
    await user.tab();
    expect(passwordField()).toHaveFocus();
    await user.tab();
    expect(submitButton()).toHaveFocus();
  });

  it("signs in with Enter and lands on the chat, with focus on main", async () => {
    const { router } = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD);
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
    expect(router.state.historyAction).toBe("REPLACE"); // Back doesn't return to the form
    expect(screen.getByRole("main")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("signs in from the username field with Enter too", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in" });
    await user.type(passwordField(), MOCK_PASSWORD);
    await user.type(usernameField(), "maria.santos{Enter}");
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
  });

  it.each([
    ["a wrong password", "maria.santos", "Not-the-password-1"],
    ["an unknown user", "nobody.here", MOCK_PASSWORD],
  ])("shows the same inline error for %s, tied to both fields", async (_, username, password) => {
    const { router } = renderApp("/login");
    await signInThroughForm(username, password);
    const alert = await screen.findByText(LOGIN_ERRORS.credentials);
    expect(alert).toHaveAttribute("role", "alert");
    for (const field of [usernameField(), passwordField()]) {
      expect(field).toHaveAttribute("aria-invalid", "true");
      expect(field).toHaveAttribute("aria-describedby", alert.id);
    }
    expect(router.state.location.pathname).toBe("/login");
    expect(submitButton()).toHaveTextContent("Sign in");
  });

  it("selects the password after a failed attempt, so typing replaces it", async () => {
    const user = await (async () => {
      renderApp("/login");
      return signInThroughForm("maria.santos", "Not-the-password-1");
    })();
    await screen.findByText(LOGIN_ERRORS.credentials);
    expect(passwordField()).toHaveFocus();
    await user.keyboard(`${MOCK_PASSWORD}{Enter}`);
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
  });

  it("clears the error when the next attempt starts", async () => {
    const auth = fakeAuthService();
    let finish: (result: SignInResult) => void = () => undefined;
    auth.signIn = vi
      .fn<AuthService["signIn"]>()
      .mockResolvedValueOnce({ ok: false, reason: "credentials" })
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    renderApp("/login", auth);
    const user = await signInThroughForm("maria.santos", "wrong");
    await screen.findByText(LOGIN_ERRORS.credentials);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByText(LOGIN_ERRORS.credentials)).toBeNull());
    expect(usernameField()).not.toHaveAttribute("aria-invalid");
    finish({ ok: false, reason: "credentials" });
    expect(await screen.findByText(LOGIN_ERRORS.credentials)).toBeVisible();
  });

  it.each([
    ["username", "", "pw"],
    ["password", "maria.santos", ""],
    ["username (spaces only)", "   ", "pw"],
  ])("asks for both fields when the %s is empty, without calling Cognito", async (_, username, password) => {
    const auth = fakeAuthService();
    renderApp("/login", auth);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Sign in" });
    if (username) await user.type(usernameField(), username);
    if (password) await user.type(passwordField(), password);
    await user.click(submitButton());
    expect(await screen.findByText(LOGIN_ERRORS.empty)).toHaveAttribute("role", "alert");
    expect(auth.signIn).not.toHaveBeenCalled();
  });

  it("passes the trimmed username and the password as typed", async () => {
    const auth = fakeAuthService();
    renderApp("/login", auth);
    await signInThroughForm("  maria.santos ", " pass word ");
    expect(auth.signIn).toHaveBeenCalledWith("maria.santos", " pass word ");
  });

  it("shows a loading state while signing in and ignores more submits until it ends", async () => {
    const auth = fakeAuthService();
    let finish: (result: SignInResult) => void = () => undefined;
    auth.signIn = vi.fn(() => new Promise<SignInResult>((resolve) => (finish = resolve)));
    const { router } = renderApp("/login", auth);
    const user = await signInThroughForm("maria.santos", "pw");
    expect(submitButton()).toHaveTextContent("Signing in…");
    expect(submitButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button").closest("form")).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Enter}");
    await user.click(submitButton());
    expect(auth.signIn).toHaveBeenCalledTimes(1);
    finish({ ok: true, user: { username: "maria.santos" } });
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
  });

  it("ends the loading state after a failure, so the patient can try again", async () => {
    const auth = fakeAuthService();
    auth.signIn = vi.fn<AuthService["signIn"]>().mockResolvedValue({ ok: false, reason: "credentials" });
    renderApp("/login", auth);
    const user = await signInThroughForm("maria.santos", "pw");
    await screen.findByText(LOGIN_ERRORS.credentials);
    expect(submitButton()).toHaveTextContent("Sign in");
    expect(submitButton()).toHaveAttribute("aria-disabled", "false");
    await user.keyboard("{Enter}");
    expect(auth.signIn).toHaveBeenCalledTimes(2);
  });

  it("explains, without blaming the credentials, when Cognito can't be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureCognitoMock({ fault: "network" });
    renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD);
    expect(await screen.findByText(LOGIN_ERRORS.unavailable)).toHaveAttribute("role", "alert");
  });

  it("explains when the account needs a step this page doesn't offer", async () => {
    renderApp("/login");
    await signInThroughForm("new.patient", MOCK_PASSWORD);
    expect(await screen.findByText(LOGIN_ERRORS.unsupported)).toHaveAttribute("role", "alert");
  });

  it("sends a signed-in patient straight to the chat", async () => {
    const { router } = renderApp("/login", fakeAuthService({ username: "maria.santos" }));
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
    expect(router.state.historyAction).toBe("REPLACE");
  });
});

describe("session (FR-002, FR-003)", () => {
  it.each(["/login", "/chat"])(
    "shows a status, not the page, while %s checks the stored session",
    async (path) => {
      const auth = fakeAuthService();
      auth.currentUser = vi.fn(() => new Promise<undefined>(() => undefined));
      renderApp(path, auth);
      expect(await screen.findByRole("status")).toHaveTextContent("Checking your session…");
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    },
  );

  it("redirects /chat to /login when signed out", async () => {
    const { router } = renderApp("/chat");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("keeps the patient signed in across a reload", async () => {
    const first = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD);
    await screen.findByRole("heading", { name: "Chat" });
    first.unmount();

    const { router } = renderApp("/chat");
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
  });

  it("signs out: back to /login, the session is gone, and /chat redirects again", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD);
    await screen.findByRole("heading", { name: "Chat" });
    await expect(getIdToken()).resolves.toBeTypeOf("string");

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(within(screen.getByRole("banner")).queryByRole("button")).toBeNull();
    await expect(getIdToken()).resolves.toBeUndefined();

    await router.navigate("/chat");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(screen.queryByRole("heading", { name: "Chat" })).toBeNull();
  });

  it("signs out from a page outside the guard and ends on /login", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/no-such-page", fakeAuthService({ username: "maria.santos" }));
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("needs an AuthProvider above anything that reads auth state", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<SignOutButton />)).toThrow(/AuthProvider/);
  });

  it("ends on /login even when sign-out fails", async () => {
    const user = userEvent.setup();
    const auth = fakeAuthService({ username: "maria.santos" });
    auth.signOut = vi.fn(() => Promise.reject(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { router } = renderApp("/chat", auth);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("shows sign-out progress and ignores a second click", async () => {
    const user = userEvent.setup();
    const auth = fakeAuthService({ username: "maria.santos" });
    let finish: () => void = () => undefined;
    auth.signOut = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderApp("/chat", auth);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    const button = screen.getByRole("button", { name: "Signing out…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    finish();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  it("goes to /login when a silent refresh finds the session revoked", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 });
    const { router } = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD);
    await screen.findByRole("heading", { name: "Chat" });

    expireCognitoSessions();
    await expect(getIdToken()).resolves.toBeUndefined();
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("stops listening for session changes when unmounted", async () => {
    const auth = fakeAuthService({ username: "maria.santos" });
    const { unmount } = renderApp("/chat", auth);
    await screen.findByRole("heading", { name: "Chat" });
    unmount();
    vi.mocked(auth.currentUser).mockClear();
    auth.emitChange();
    expect(auth.currentUser).not.toHaveBeenCalled();
  });
});
