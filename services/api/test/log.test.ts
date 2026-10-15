/** Structured logging helpers (`lib/log.ts`): what an error contributes to a log line. */
import { describe, expect, it } from "vitest";

import { errorSummary } from "../src";

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
