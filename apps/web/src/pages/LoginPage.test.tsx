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

import { pageTitle } from "../app/pageTitle";
import { appRoutes } from "../app/routes";
import type { AuthService, SignInResult } from "../auth/authService";
import { SignOutButton } from "../auth/SignOutButton";
import { getIdToken } from "../auth/session";
import { fakeAuthService } from "../auth/testing";
import { configureCognitoMock, expireCognitoSessions } from "../mocks/cognito";
import { MOCK_PASSWORD } from "../mocks/cognitoUsers";
import { LOGIN_ERRORS } from "./LoginPage";

// Each sign-in runs SRP's 3072-bit math on both sides (~0.2 s alone); allow for a busy CI machine.
vi.setConfig({ testTimeout: 20_000 });

// The wait for anything that goes through the Cognito mock (real Amplify, real SRP), in the tests that
// render without a fake `auth`. A loaded runner can spend the 3 s default (src/test/setup.ts) on one
// sign-in: at a load average near 190, 8-9 of these tests' waits ran out at the old 1 s (PR #133). 10 s is half the
// test timeout above, so a wait that never succeeds still fails as a missing element, not a timeout.
// Waits on `fakeAuthService` keep the default; nothing slow sits behind them.
const COGNITO = { timeout: 10_000 };

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

/** Render the app at `path`, with the real (mock-backed) auth service unless `auth` is given. */
function renderApp(path: string, auth?: AuthService) {
  const router = createMemoryRouter(appRoutes(undefined, auth), { initialEntries: [path] });
  const view = render(<RouterProvider router={router} />);
  return { router, unmount: view.unmount };
}

const usernameField = () => screen.getByLabelText("Username");
const passwordField = () => screen.getByLabelText("Password");
const submitButton = () => screen.getByRole("button", { name: /Sign(ing)? in/ });

async function signInThroughForm(username: string, password: string, wait: { timeout?: number } = {}) {
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "Sign in" }, wait);
  await user.type(usernameField(), username);
  await user.type(passwordField(), `${password}{Enter}`);
  return user;
}

describe("login form (FR-001)", () => {
  it("labels its fields for password managers and screen readers, in tab order, with no sign-up link", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in" }, COGNITO);
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
    await signInThroughForm("maria.santos", MOCK_PASSWORD, COGNITO);
    expect(await screen.findByRole("heading", { name: "Chat" }, COGNITO)).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
    expect(router.state.historyAction).toBe("REPLACE"); // Back doesn't return to the form
    // Layout moves focus in an effect after the navigation renders, so wait for it.
    await waitFor(() => {
      expect(screen.getByRole("main")).toHaveFocus();
    }, COGNITO);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("signs in from the username field with Enter too", async () => {
    const user = userEvent.setup();
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in" }, COGNITO);
    await user.type(passwordField(), MOCK_PASSWORD);
    await user.type(usernameField(), "maria.santos{Enter}");
    expect(await screen.findByRole("heading", { name: "Chat" }, COGNITO)).toBeVisible();
  });

  it.each([
    ["a wrong password", "maria.santos", "Not-the-password-1"],
    ["an unknown user", "nobody.here", MOCK_PASSWORD],
  ])("shows the same inline error for %s, tied to both fields", async (_, username, password) => {
    const { router } = renderApp("/login");
    await signInThroughForm(username, password, COGNITO);
    const alert = await screen.findByText(LOGIN_ERRORS.credentials, {}, COGNITO);
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
      return signInThroughForm("maria.santos", "Not-the-password-1", COGNITO);
    })();
    await screen.findByText(LOGIN_ERRORS.credentials, {}, COGNITO);
    expect(passwordField()).toHaveFocus();
    await user.keyboard(`${MOCK_PASSWORD}{Enter}`);
    expect(await screen.findByRole("heading", { name: "Chat" }, COGNITO)).toBeVisible();
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
    finish({ ok: true, user: { username: "maria.santos", sub: "sub-maria.santos" } });
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
    await signInThroughForm("maria.santos", MOCK_PASSWORD, COGNITO);
    expect(await screen.findByText(LOGIN_ERRORS.unavailable, {}, COGNITO)).toHaveAttribute("role", "alert");
  });

  it("explains when the account needs a step this page doesn't offer", async () => {
    renderApp("/login");
    await signInThroughForm("new.patient", MOCK_PASSWORD, COGNITO);
    expect(await screen.findByText(LOGIN_ERRORS.unsupported, {}, COGNITO)).toHaveAttribute("role", "alert");
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
      expect(document.title).toBe(pageTitle("Checking your session"));
    },
  );

  it("redirects /chat to /login when signed out", async () => {
    const { router } = renderApp("/chat");
    expect(await screen.findByRole("heading", { name: "Sign in" }, COGNITO)).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("keeps the patient signed in across a reload", async () => {
    const first = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD, COGNITO);
    await screen.findByRole("heading", { name: "Chat" }, COGNITO);
    first.unmount();

    // A reload starts the app over: fresh modules, so a fresh auth service that has only what the
    // browser stored to go on.
    vi.resetModules();
    const fresh = await import("../app/routes");
    const router = createMemoryRouter(fresh.appRoutes(), { initialEntries: ["/chat"] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: "Chat" }, COGNITO)).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
  });

  it("signs out: back to /login, the session is gone, and /chat redirects again", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD, COGNITO);
    await screen.findByRole("heading", { name: "Chat" }, COGNITO);
    await expect(getIdToken()).resolves.toBeTypeOf("string");

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" }, COGNITO)).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(within(screen.getByRole("banner")).queryByRole("button")).toBeNull();
    await expect(getIdToken()).resolves.toBeUndefined();

    await router.navigate("/chat");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"), COGNITO);
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

  // The button stays mounted in Layout while signed out (it renders nothing), so its guard must be
  // cleared after a sign-out, or the next sign-out in the same page session would be ignored.
  it("signs out again after signing back in", async () => {
    const user = userEvent.setup();
    const auth = fakeAuthService({ username: "maria.santos" });
    const { router } = renderApp("/chat", auth);
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await signInThroughForm("maria.santos", "pw");
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(auth.signOut).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe("/login");
  });

  it("goes to /login when a silent refresh finds the session revoked", async () => {
    configureCognitoMock({ tokenLifetimeSeconds: 1 });
    const { router } = renderApp("/login");
    await signInThroughForm("maria.santos", MOCK_PASSWORD, COGNITO);
    await screen.findByRole("heading", { name: "Chat" }, COGNITO);

    expireCognitoSessions();
    await expect(getIdToken()).resolves.toBeUndefined();
    expect(await screen.findByRole("heading", { name: "Sign in" }, COGNITO)).toBeVisible();
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
