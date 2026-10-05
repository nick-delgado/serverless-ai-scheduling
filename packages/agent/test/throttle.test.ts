import { describe, expect, it } from "vitest";

import { THROTTLE_NAMES, httpStatusOf, isThrottle } from "../src";

const named = (name: string) => Object.assign(new Error("slow down"), { name });

describe("isThrottle (#105)", () => {
  it("is the union of the API's and the evals' throttling names (r1/Q-2)", () => {
    expect([...THROTTLE_NAMES].sort()).toEqual([
      "ServiceQuotaExceededException",
      "Throttling",
      "ThrottlingException",
      "TooManyRequestsException",
    ]);
  });

  it.each(["ThrottlingException", "TooManyRequestsException", "ServiceQuotaExceededException", "Throttling"])(
    "recognises an Error named %s",
    (name) => {
      expect(isThrottle(named(name))).toBe(true);
    },
  );

  it("reads the name from a plain object too, not only an Error (r1/A-3)", () => {
    expect(isThrottle({ name: "Throttling" })).toBe(true);
  });

  it.each([
    ["$metadata.httpStatusCode", { $metadata: { httpStatusCode: 429 } }],
    ["statusCode", { statusCode: 429 }],
    ["status", { status: 429 }],
  ])("recognises HTTP 429 in %s", (_field, error) => {
    expect(isThrottle(Object.assign(new Error("x"), error))).toBe(true);
  });

  it.each([
    ["another name", named("ValidationException")],
    ["a 503", { $metadata: { httpStatusCode: 503 } }],
    ["a non-string name", { name: 429 }],
    ["a string", "ThrottlingException"],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, error) => {
    expect(isThrottle(error)).toBe(false);
  });
});

describe("httpStatusOf (#105)", () => {
  it("reads $metadata.httpStatusCode, then statusCode, then status: the first one defined wins", () => {
    expect(httpStatusOf({ $metadata: { httpStatusCode: 429 }, statusCode: 500, status: 503 })).toBe(429);
    expect(httpStatusOf({ $metadata: {}, statusCode: 500, status: 503 })).toBe(500);
    expect(httpStatusOf({ status: 503 })).toBe(503);
    // Defined, not truthy: a 0 still wins over a later field.
    expect(httpStatusOf({ $metadata: { httpStatusCode: 0 }, statusCode: 429 })).toBe(0);
    expect(httpStatusOf({ statusCode: 0, status: 429 })).toBe(0);
  });

  it("counts only a number", () => {
    expect(httpStatusOf({ status: "429" })).toBeUndefined();
    expect(httpStatusOf({ $metadata: { httpStatusCode: "429" }, status: 503 })).toBeUndefined();
    expect(httpStatusOf(new Error("no status"))).toBeUndefined();
    expect(httpStatusOf(undefined)).toBeUndefined();
  });
});
