/**
 * The app sends the login's ID token (#36's token-wiring criterion, moved to #29): through the real route
 * tree and the real auth service (Amplify against the Cognito mock), the session call and a chat turn
 * carry `Authorization: <ID token>`, the raw token the API's Cognito authorizer reads (`chat/api.ts`).
 * Without it, every request on a deployed env was a 401 and the patient was sent back to sign-in.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAuthService, getIdToken } from "../auth/session";
import { log, until, untilFound } from "../chat/testUtils";
import { MOCK_PASSWORD } from "../mocks/cognitoUsers";
import { REPLIES } from "../mocks/fixtures";
import { configureMockApi, server } from "../mocks/node";
import { appRoutes } from "./routes";

// A real SRP sign-in, then the page's I/O on the mock API (testUtils.ts, #134).
vi.setConfig({ testTimeout: 20_000 });

/** `Authorization` of each API request, by path. */
let seen: { path: string; authorization: string | null }[];
const onRequest = ({ request }: { request: Request }) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/"))
    seen.push({ path: pathname, authorization: request.headers.get("authorization") });
};

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
  seen = [];
  server.events.on("request:start", onRequest);
  await defaultAuthService().signOut();
  await expect(defaultAuthService().signIn("maria.santos", MOCK_PASSWORD)).resolves.toMatchObject({
    ok: true,
  });
});

afterEach(() => {
  server.events.removeListener("request:start", onRequest);
  vi.unstubAllGlobals();
});

function renderApp() {
  const router = createMemoryRouter(appRoutes(), { initialEntries: ["/chat"] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("the /chat route, signed in with the app's auth service", () => {
  it("sends the ID token as Authorization on the session call and on a chat turn", async () => {
    const token = await getIdToken();
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    renderApp();
    const input = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.setup().type(input, "Hi{Enter}");
    await untilFound(() => within(log()).queryByText(REPLIES.tools.text));
    expect(seen.map((request) => request.path)).toEqual(["/api/session", "/api/chat"]);
    expect(seen.map((request) => request.authorization)).toEqual([token, token]);
  });

  it("signs the patient out, to /login, when a chat turn answers 401", async () => {
    configureMockApi({ chatFault: "unauthorized" });
    const router = renderApp();
    const input = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.setup().type(input, "Hi{Enter}");
    await until(() => router.state.location.pathname === "/login");
    expect(router.state.location.pathname).toBe("/login");
    await expect(defaultAuthService().currentUser()).resolves.toBeUndefined();
  });
});
