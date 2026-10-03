/** Structured logging helpers (`lib/log.ts`): what an error contributes to a log line, and level routing. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { consoleLogger, errorSummary } from "../src";

afterEach(() => vi.restoreAllMocks());

describe("errorSummary", () => {
  it("keeps the name and clips the message to 200 characters", () => {
    const summary = errorSummary(new Error("x".repeat(250)));
    // Strict: an absent code or status must not appear as an undefined field either.
    expect(summary).toStrictEqual({ errorName: "Error", errorMessage: "x".repeat(200) });
  });

  it("adds the AWS error code and HTTP status when the error has them", () => {
    const error = Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
      code: "ThrottlingException",
      $metadata: { httpStatusCode: 429 },
    });
    expect(errorSummary(error)).toEqual({
      errorName: "ThrottlingException",
      errorMessage: "Rate exceeded",
      errorCode: "ThrottlingException",
      httpStatus: 429,
    });
  });

  it("leaves out a code that isn't a string", () => {
    expect(errorSummary(Object.assign(new Error("x"), { code: 42 }))).not.toHaveProperty("errorCode");
  });

  it("logs only the type of a thrown non-error, never its value", () => {
    expect(errorSummary("the patient said something")).toEqual({ errorType: "string" });
  });
});

describe("consoleLogger", () => {
  it("routes by level and leaves the level out of the entry", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    consoleLogger({ msg: "a" });
    consoleLogger({ msg: "b", level: "info" });
    consoleLogger({ msg: "c", level: "warn" });
    consoleLogger({ msg: "d", level: "error" });

    expect(info.mock.calls).toEqual([[{ msg: "a" }], [{ msg: "b" }]]);
    expect(warn.mock.calls).toEqual([[{ msg: "c" }]]);
    expect(error.mock.calls).toEqual([[{ msg: "d" }]]);
  });
});
