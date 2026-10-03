/** Buffered JSON responses (`lib/http.ts`), for the REST API proxy handlers. */
import type { ChatErrorCode } from "@sched/contracts";
import { describe, expect, it } from "vitest";

import { JSON_HEADERS, errorResponse, jsonResponse } from "../src/lib/http";

describe("jsonResponse", () => {
  it("serializes the body with JSON headers that forbid caching", () => {
    const res = jsonResponse(200, { ok: true });
    expect(res).toEqual({ statusCode: 200, headers: { ...JSON_HEADERS }, body: '{"ok":true}' });
    expect(res.headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("gives each response its own headers object", () => {
    const res = jsonResponse(200, {});
    res.headers["X-Test"] = "1";
    expect(JSON_HEADERS).not.toHaveProperty("X-Test");
  });
});

describe("errorResponse", () => {
  it("builds an ApiError body", () => {
    const res = errorResponse(401, "UNAUTHORIZED", "Please sign in again.");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "UNAUTHORIZED", message: "Please sign in again." },
    });
  });

  it("refuses a body that breaks the ApiError contract", () => {
    expect(() => errorResponse(400, "NOPE" as ChatErrorCode, "x")).toThrow();
    expect(() => errorResponse(400, "BAD_REQUEST", "")).toThrow();
  });
});
