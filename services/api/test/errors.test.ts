import { describe, expect, it } from "vitest";

import { classifyAgentError } from "../src";

describe("classifyAgentError", () => {
  it.each([
    ["the throttling exception name", Object.assign(new Error("slow down"), { name: "ThrottlingException" })],
    [
      "HTTP 429 alone",
      Object.assign(new Error("slow down"), { name: "SomethingElse", $metadata: { httpStatusCode: 429 } }),
    ],
  ])("maps %s to a retryable RATE_LIMITED (429)", (_name, error) => {
    expect(classifyAgentError(error)).toEqual({
      httpStatus: 429,
      event: expect.objectContaining({ code: "RATE_LIMITED", retryable: true }),
    });
  });

  it.each([
    [
      "a 5xx",
      Object.assign(new Error("x"), { name: "InternalServerException", $metadata: { httpStatusCode: 500 } }),
    ],
    ["an abort", new DOMException("The operation timed out.", "TimeoutError")],
    ["a non-error", "boom"],
  ])("maps %s to a retryable AGENT_UNAVAILABLE (503)", (_name, error) => {
    expect(classifyAgentError(error)).toEqual({
      httpStatus: 503,
      event: expect.objectContaining({ code: "AGENT_UNAVAILABLE", retryable: true }),
    });
  });
});
