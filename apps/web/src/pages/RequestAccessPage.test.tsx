/**
 * The reviewer access page (#357; FR-001 amended). Most tests run it on the dev server's path: no site key, so the
 * mock bot check supplies the mock API's token. The widget tests stub `window.turnstile` and the script's load.
 */
import { ACCESS_CAP_MESSAGE } from "@sched/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MOCK_BOT_CHECK_TOKEN } from "../mocks/cognitoUsers";
import { pageRoutesFor, appRoutes } from "../app/routes";
import { MOCK_ISSUED_USER, MOCK_PASSWORD } from "../mocks/cognitoUsers";
import { configureMockApi, server } from "../mocks/node";
import { README_URL, UNAVAILABLE_MESSAGE } from "./RequestAccessPage";

vi.setConfig({ testTimeout: 20_000 });
const COGNITO = { timeout: 10_000 };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete window.turnstile;
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

function renderApp(path = "/request-access") {
  const router = createMemoryRouter(appRoutes(pageRoutesFor(true)), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

const requestButton = () => screen.getByRole("button", { name: /Request demo access|Creating/ });

describe("the request page", () => {
  it("asks for nothing about the reviewer: no text field, only one button and the bot check", async () => {
    renderApp();
    expect(await screen.findByRole("heading", { name: "Request demo access" })).toBeVisible();
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryByLabelText(/email|name|phone/i)).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  });

  it("shows the username, the password and the patient's name once, and links to sign in", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));

    expect(await screen.findByRole("heading", { name: "Your demo account" })).toBeVisible();
    expect(screen.getByText(MOCK_ISSUED_USER.username)).toBeVisible();
    expect(screen.getByText(MOCK_PASSWORD)).toBeVisible();
    expect(screen.getByText(`${MOCK_ISSUED_USER.givenName} ${MOCK_ISSUED_USER.familyName}`)).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute("href", "/login");
  });

  it("keeps the password in the page's state only: nothing in local or session storage, and a fresh page asks again", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    await screen.findByText(MOCK_PASSWORD);
    expect(set).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(MOCK_PASSWORD);

    document.body.innerHTML = "";
    renderApp();
    expect(await screen.findByRole("button", { name: "Request demo access" })).toBeVisible();
    expect(screen.queryByText(MOCK_PASSWORD)).toBeNull();
  });

  it("copies the username and password", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    await user.click(await screen.findByRole("button", { name: "Copy username and password" }));
    expect(await navigator.clipboard.readText()).toBe(
      `Username: ${MOCK_ISSUED_USER.username}\nPassword: ${MOCK_PASSWORD}`,
    );
    expect(await screen.findByText("Copied.")).toBeVisible();
  });

  it("says nothing was copied when the clipboard refuses", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    await user.click(await screen.findByRole("button", { name: "Copy username and password" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText("Copied.")).toBeNull();
  });

  it("shows the cap message with a link to the README and takes the button away", async () => {
    configureMockApi({ accessFault: "capped" });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(ACCESS_CAP_MESSAGE);
    expect(screen.getByRole("link", { name: "Open the project README" })).toHaveAttribute("href", README_URL);
    expect(requestButton()).toBeDisabled();
    expect(screen.queryByText(MOCK_PASSWORD)).toBeNull();
  });

  it("asks to try again after a bot-check failure, with the button still usable", async () => {
    configureMockApi({ accessFault: "bot_check" });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The check didn't pass. Please try again.");
    expect(requestButton()).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Open the project README" })).toBeNull();
  });

  it.each(["retry", "network"] as const)("asks to try again after a %s failure", async (accessFault) => {
    configureMockApi({ accessFault });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(requestButton()).toBeEnabled();
  });

  it("clears an earlier failure's message as soon as the next request goes out", async () => {
    configureMockApi({ accessFault: "retry" });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    await screen.findByText(/try again/i);
    // Hold the next request open, so the page is seen while it is pending.
    server.use(
      http.post("/api/request-access", async () => {
        await new Promise((r) => setTimeout(r, 150));
        return HttpResponse.json(
          { error: { code: "TRY_AGAIN", message: "Second failure." } },
          { status: 503 },
        );
      }),
    );
    await user.click(requestButton());
    await screen.findByRole("button", { name: "Creating your account…" });
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(await screen.findByText("Second failure.")).toBeVisible();
  });

  it("shows when the account is due to expire, in the clinic's time zone, from the response", async () => {
    server.use(
      http.post("/api/request-access", () =>
        HttpResponse.json({
          username: "user-x7k2m9qa",
          password: "Sample-Only-Pw-0000",
          firstName: "Noor",
          lastName: "Vance",
          expiresAt: "2026-10-21T15:00:00Z",
        }),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    expect(await screen.findByText(/due to expire on Oct 21, 2026, 11:00 AM EDT/)).toBeVisible();
    expect(screen.queryByText(/about a day/)).toBeNull();
  });

  it("shows that it is working while the request is out, then goes back to the button", async () => {
    server.use(
      http.post("/api/request-access", async () => {
        await new Promise((r) => setTimeout(r, 80));
        return HttpResponse.json({ error: { code: "TRY_AGAIN", message: "Try again." } }, { status: 503 });
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    const busy = await screen.findByRole("button", { name: "Creating your account…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    await screen.findByText("Try again.");
    const idle = screen.getByRole("button", { name: "Request demo access" });
    expect(idle).toHaveAttribute("aria-busy", "false");
  });

  it("starts with nothing copied", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    await screen.findByRole("button", { name: "Copy username and password" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("sends one request for a double click", async () => {
    let calls = 0;
    server.use(
      http.post("/api/request-access", async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ error: { code: "TRY_AGAIN", message: "Try again." } }, { status: 503 });
      }),
    );
    const user = userEvent.setup();
    renderApp();
    const button = await screen.findByRole("button", { name: "Request demo access" });
    await user.dblClick(button);
    await screen.findByText("Try again.");
    expect(calls).toBe(1);
  });

  it("lets a reviewer sign in with what the page showed (the mock Cognito accepts the issued user)", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));
    const username = (await screen.findByText(MOCK_ISSUED_USER.username)).textContent ?? "";
    const password = screen.getByText(MOCK_PASSWORD).textContent ?? "";
    await user.click(screen.getByRole("link", { name: "Go to sign in" }));

    await user.type(await screen.findByLabelText("Username"), username);
    await user.type(screen.getByLabelText("Password"), `${password}{Enter}`);
    expect(await screen.findByRole("heading", { name: "Chat" }, COGNITO)).toBeVisible();
  });
});

describe("the Turnstile widget", () => {
  const SITE_KEY = "1x00000000000000000000AA";
  interface RenderOptions {
    sitekey: string;
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }

  function fakeTurnstile() {
    const rendered: RenderOptions[] = [];
    const api = {
      render: vi.fn((_container: HTMLElement, options: RenderOptions) => {
        rendered.push(options);
        return "widget-1";
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    window.turnstile = api;
    return { api, rendered };
  }
  const scriptEl = () =>
    document.head.querySelector<HTMLScriptElement>("script[src*='challenges.cloudflare.com']");
  const loadScript = async () => {
    await waitFor(() => expect(scriptEl()).not.toBeNull());
    scriptEl()?.dispatchEvent(new Event("load"));
  };

  // The module keeps one loading promise; a fresh module per test starts without it.
  async function freshApp() {
    vi.resetModules();
    const routes = await import("../app/routes");
    const mount = () => {
      const router = createMemoryRouter(routes.appRoutes(routes.pageRoutesFor(true)), {
        initialEntries: ["/request-access"],
      });
      return render(<RouterProvider router={router} />);
    };
    mount();
    return mount;
  }
  const scriptCount = () => document.head.querySelectorAll("script[src*='challenges.cloudflare.com']").length;

  it("loads Cloudflare's script, renders the widget with the site key, and enables the button on a token", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const { api, rendered } = fakeTurnstile();
    await freshApp();
    const button = await screen.findByRole("button", { name: "Request demo access" });
    expect(button).toBeDisabled();
    await loadScript();
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    expect(scriptEl()?.src).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");
    expect(rendered[0]?.sitekey).toBe(SITE_KEY);

    rendered[0]?.callback("widget-token");
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("loads the script once for the module: a second mount reuses it and renders again", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const { api } = fakeTurnstile();
    const mount = await freshApp();
    await loadScript();
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    cleanup();
    mount();
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(2));
    expect(scriptCount()).toBe(1);
  });

  it("tries the script again on the next mount after a failed load", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const mount = await freshApp();
    await waitFor(() => expect(scriptCount()).toBe(1));
    scriptEl()?.dispatchEvent(new Event("error"));
    await screen.findByText(UNAVAILABLE_MESSAGE);
    cleanup();
    mount();
    await waitFor(() => expect(scriptCount()).toBe(2));
  });

  it("sends the widget's token, then asks the widget for a fresh one", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const { api, rendered } = fakeTurnstile();
    let sent: unknown;
    server.use(
      http.post("/api/request-access", async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(
          { error: { code: "BOT_CHECK_FAILED", message: "Not this time." } },
          { status: 403 },
        );
      }),
    );
    const user = userEvent.setup();
    await freshApp();
    await loadScript();
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    rendered[0]?.callback("widget-token");
    await user.click(await screen.findByRole("button", { name: "Request demo access" }));

    await screen.findByText("Not this time.");
    expect(sent).toEqual({ turnstileToken: "widget-token" });
    expect(api.reset).toHaveBeenCalledWith("widget-1");
    // The spent token is gone until the widget gives another.
    expect(requestButton()).toBeDisabled();
  });

  it("takes the token away when the widget says it expired or errored", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const { api, rendered } = fakeTurnstile();
    await freshApp();
    await loadScript();
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    rendered[0]?.callback("t");
    await waitFor(() => expect(requestButton()).toBeEnabled());
    rendered[0]?.["expired-callback"]();
    await waitFor(() => expect(requestButton()).toBeDisabled());
    rendered[0]?.callback("t2");
    await waitFor(() => expect(requestButton()).toBeEnabled());
    rendered[0]?.["error-callback"]();
    await waitFor(() => expect(requestButton()).toBeDisabled());
  });

  it("says the bot check couldn't load, with the button off, when the script fails", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    await freshApp();
    await waitFor(() => expect(scriptEl()).not.toBeNull());
    scriptEl()?.dispatchEvent(new Event("error"));
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE_MESSAGE);
    expect(requestButton()).toBeDisabled();
  });

  it("says the bot check couldn't start when the script loads without defining turnstile", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    await freshApp();
    await loadScript();
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE_MESSAGE);
  });

  it("removes the widget when the page goes away", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const { api } = fakeTurnstile();
    await freshApp();
    await loadScript();
    await waitFor(() => expect(api.render).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Back to sign in" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("widget-1"));
  });

  it("loads no widget script on the dev server's mock bot check", async () => {
    renderApp();
    await screen.findByRole("button", { name: "Request demo access" });
    expect(scriptEl()).toBeNull();
    expect(document.querySelector(".access__widget")).toBeNull();
  });

  it("takes the widget away once its script has failed", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    await freshApp();
    expect(document.querySelector(".access__widget")).not.toBeNull();
    await waitFor(() => expect(scriptEl()).not.toBeNull());
    scriptEl()?.dispatchEvent(new Event("error"));
    await screen.findByText(UNAVAILABLE_MESSAGE);
    expect(document.querySelector(".access__widget")).toBeNull();
  });

  it("renders nothing into the widget if the page went away before the script loaded", async () => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    const { api } = fakeTurnstile();
    const user = userEvent.setup();
    await freshApp();
    await waitFor(() => expect(scriptEl()).not.toBeNull());
    await user.click(screen.getByRole("link", { name: "Back to sign in" }));
    await screen.findByRole("heading", { name: "Sign in" });
    await loadScript();
    await new Promise((r) => setTimeout(r, 20));
    expect(api.render).not.toHaveBeenCalled();
  });

  it("is unavailable, and sends nothing, in a production build with no site key", async () => {
    vi.stubEnv("DEV", false);
    let calls = 0;
    server.use(
      http.post("/api/request-access", () => {
        calls += 1;
        return HttpResponse.json({});
      }),
    );
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent(UNAVAILABLE_MESSAGE);
    expect(requestButton()).toBeDisabled();
    expect(calls).toBe(0);
  });

  it("uses the mock token only when there is no site key", async () => {
    // With a site key set, the dev server's mock token is not sent: the button waits for the widget.
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", SITE_KEY);
    fakeTurnstile();
    await freshApp();
    expect(await screen.findByRole("button", { name: "Request demo access" })).toBeDisabled();
    const alert = screen.getByRole("alert");
    expect(within(alert).queryByText(/./)).toBeNull();
  });
});
