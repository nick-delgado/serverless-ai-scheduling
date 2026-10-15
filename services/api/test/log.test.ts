/** Structured logging helpers (`lib/log.ts`): what an error contributes to a log line. */
import { describe, expect, it } from "vitest";

import { errorSummary } from "../src";

describe("errorSummary", () => {
  it("keeps only the name of an error that isn't an AWS SDK error, never its message (r1/Q-5 (b))", () => {
    const summary = errorSummary(new Error("Maria Chen, 555-0142"));
    // Strict: an absent message, code or status must not appear as an undefined field either.
    expect(summary).toStrictEqual({ errorName: "Error" });
  });

  it("clips an AWS SDK error's message to 200 characters", () => {
    const error = Object.assign(new Error("x".repeat(250)), { $metadata: {} });
    expect(errorSummary(error)).toStrictEqual({ errorName: "Error", errorMessage: "x".repeat(200) });
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

  it("keeps the code of an error that isn't an AWS SDK error, and still drops its message", () => {
    const error = Object.assign(new Error("Maria Chen"), { code: "ENOTFOUND" });
    expect(errorSummary(error)).toStrictEqual({ errorName: "Error", errorCode: "ENOTFOUND" });
  });

  it("leaves out a code that isn't a string", () => {
    expect(errorSummary(Object.assign(new Error("x"), { code: 42 }))).not.toHaveProperty("errorCode");
  });

  it("logs only the type of a thrown non-error, never its value", () => {
    expect(errorSummary("the patient said something")).toEqual({ errorType: "string" });
  });
});
