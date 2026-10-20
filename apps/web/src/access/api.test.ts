import { ACCESS_CAP_MESSAGE } from "@sched/contracts";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { configureMockApi, server } from "../mocks/node";
import { MOCK_ISSUED_USER, MOCK_PASSWORD } from "../mocks/cognitoUsers";
import { MOCK_BOT_CHECK_TOKEN } from "./config";
import { RETRY_MESSAGE, requestAccess } from "./api";

describe("requestAccess", () => {
  it("posts the token and nothing else, with no Authorization header, and returns the account", async () => {
    let seen: { body: unknown; auth: string | null } | undefined;
    server.use(
      http.post("/api/request-access", async ({ request }) => {
        seen = { body: await request.json(), auth: request.headers.get("Authorization") };
        return HttpResponse.json({
          username: "user-x7k2m9qa",
          password: "Sample-Only-Pw-0000",
          firstName: "Noor",
          lastName: "Vance",
          expiresAt: "2026-10-21T10:00:00Z",
        });
      }),
    );
    const result = await requestAccess("tok");
    expect(seen).toEqual({ body: { turnstileToken: "tok" }, auth: null });
    expect(result).toEqual({
      ok: true,
      account: {
        username: "user-x7k2m9qa",
        password: "Sample-Only-Pw-0000",
        firstName: "Noor",
        lastName: "Vance",
        expiresAt: "2026-10-21T10:00:00Z",
      },
    });
  });

  it("returns the mock's account for the mock token", async () => {
    const result = await requestAccess(MOCK_BOT_CHECK_TOKEN);
    expect(result).toMatchObject({
      ok: true,
      account: { username: MOCK_ISSUED_USER.username, password: MOCK_PASSWORD },
    });
  });

  it.each([
    ["bot_check", "bot_check"],
    ["capped", "capped"],
    ["retry", "retry"],
  ] as const)("reads the mock's %s answer as kind %s", async (accessFault, kind) => {
    configureMockApi({ accessFault });
    const result = await requestAccess(MOCK_BOT_CHECK_TOKEN);
    expect(result).toMatchObject({ ok: false, kind });
  });

  it("carries the server's cap message, which points at the README", async () => {
    configureMockApi({ accessFault: "capped" });
    expect(await requestAccess(MOCK_BOT_CHECK_TOKEN)).toEqual({
      ok: false,
      kind: "capped",
      message: ACCESS_CAP_MESSAGE,
    });
  });

  it("reads a rejected token as a bot-check failure", async () => {
    expect(await requestAccess("not-the-mock-token")).toMatchObject({ ok: false, kind: "bot_check" });
  });

  it("asks to try again on a network failure", async () => {
    configureMockApi({ accessFault: "network" });
    expect(await requestAccess(MOCK_BOT_CHECK_TOKEN)).toEqual({
      ok: false,
      kind: "retry",
      message: RETRY_MESSAGE,
    });
  });

  it.each([
    ["a 200 body of the wrong shape", () => HttpResponse.json({ username: "x" })],
    ["a 200 body that isn't JSON", () => new HttpResponse("<html>", { status: 200 })],
    ["a 500 with no error body", () => new HttpResponse("oops", { status: 500 })],
    ["a 403 API Gateway body", () => HttpResponse.json({ message: "Forbidden" }, { status: 403 })],
    [
      "a BAD_REQUEST error",
      () =>
        HttpResponse.json({ error: { code: "BAD_REQUEST", message: "internal detail" } }, { status: 400 }),
    ],
  ])("asks to try again for %s, with our own message", async (_name, reply) => {
    server.use(http.post("/api/request-access", reply));
    expect(await requestAccess("tok")).toEqual({ ok: false, kind: "retry", message: RETRY_MESSAGE });
  });

  it("keeps the server's own try-again message", async () => {
    configureMockApi({ accessFault: "retry" });
    const result = await requestAccess(MOCK_BOT_CHECK_TOKEN);
    expect(result).toMatchObject({ ok: false, kind: "retry" });
    expect(result.ok ? "" : result.message).toContain("try again");
  });

  it("rethrows an aborted request instead of calling it a retry", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(requestAccess("tok", controller.signal)).rejects.toThrow();
  });
});
