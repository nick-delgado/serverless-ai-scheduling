import { CLINIC } from "@sched/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";

import type { AuthService } from "../auth/authService";
import { fakeAuthService } from "../auth/testing";
import { DISCLAIMER_TEXT } from "./DisclaimerBanner";
import { pageTitle } from "./pageTitle";
import { appRoutes, pageRoutes } from "./routes";

const signedIn = () => fakeAuthService({ username: "maria.santos" });

function renderAt(path: string, pages: RouteObject[] = pageRoutes, auth: AuthService = fakeAuthService()) {
  const router = createMemoryRouter(appRoutes(pages, auth), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

function expectDisclaimer() {
  const banner = within(screen.getByRole("banner"));
  expect(
    banner.getByText((_, el) => el?.textContent === DISCLAIMER_TEXT && el.tagName === "P"),
  ).toBeVisible();
}

describe("app shell", () => {
  it.each([
    ["/login", "Sign in"],
    ["/chat", "Chat"],
    ["/no-such-page", "Page not found"],
  ])("renders %s inside the layout, with the disclaimer and a page title", async (path, heading) => {
    renderAt(path, pageRoutes, path === "/chat" ? signedIn() : fakeAuthService());
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeVisible();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
    expectDisclaimer();
    expect(within(screen.getByRole("banner")).getByText(CLINIC.name)).toBeVisible();
    expect(document.title).toBe(pageTitle(heading));
  });

  it("uses the FR-016 wording exactly", () => {
    expect(DISCLAIMER_TEXT).toBe("Demo — fictional clinic. Do not enter real health information.");
  });

  it("sends / to the chat when signed in", async () => {
    const router = renderAt("/", pageRoutes, signedIn());
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/chat");
  });

  it("sends / to the login page when signed out", async () => {
    const router = renderAt("/");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("keeps the layout and disclaimer when a page throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const Boom = () => {
      throw new Error("render failed");
    };
    renderAt("/boom", [{ path: "boom", element: <Boom /> }]);
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeVisible();
    expect(screen.queryByText("render failed")).toBeNull();
    expectDisclaimer();
    error.mockRestore();
  });

  it("offers a skip link to main, first in tab order", async () => {
    const user = userEvent.setup();
    renderAt("/login");
    await screen.findByRole("heading", { name: "Sign in" });
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("moves focus to main after a client-side navigation, not on first load", async () => {
    const user = userEvent.setup();
    renderAt("/login");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.getByRole("main")).not.toHaveFocus();
    await user.type(screen.getByLabelText("Username"), "maria.santos");
    await user.type(screen.getByLabelText("Password"), "any{Enter}");
    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(screen.getByRole("main")).toHaveFocus();
  });
});
