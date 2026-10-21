import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as C from "./index";
import { EXAMPLES } from "./testing/examples";

const exportedSchemas = (Object.entries(C) as [string, unknown][]).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
);

describe("schema coverage", () => {
  it("exports a meaningful number of schemas", () => {
    expect(exportedSchemas.length).toBeGreaterThan(40);
  });

  it("has an example for every exported schema (keeps round-trip coverage at 100%)", () => {
    const missing = exportedSchemas.map(([name]) => name).filter((name) => !(name in EXAMPLES));
    expect(missing).toEqual([]);
  });

  it("has no examples for schemas that no longer exist", () => {
    const names = new Set(exportedSchemas.map(([name]) => name));
    expect(Object.keys(EXAMPLES).filter((name) => !names.has(name))).toEqual([]);
  });
});

describe.each(exportedSchemas)("%s", (name, schema) => {
  const example = (EXAMPLES as Record<string, unknown>)[name];

  it("accepts its example", () => {
    const result = schema.safeParse(example);
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("round-trips through JSON unchanged", () => {
    const once = schema.parse(example);
    const twice = schema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe("input mode (#234)", () => {
  const request = EXAMPLES.ChatRequest;

  it.each(["text", "voice"])("lets a chat request say inputMode %s", (inputMode) => {
    expect(C.ChatRequest.parse({ ...request, inputMode }).inputMode).toBe(inputMode);
  });

  it("lets a chat request leave inputMode out, meaning text", () => {
    const { inputMode: _omitted, ...without } = request;
    expect(C.ChatRequest.parse(without)).not.toHaveProperty("inputMode");
  });

  it.each(["phone", "", "VOICE", null, 1])("rejects a chat request whose inputMode is %j", (inputMode) => {
    expect(C.ChatRequest.safeParse({ ...request, inputMode }).success).toBe(false);
  });

  it("stores only voice on a message, and keeps it through parsing", () => {
    const message = EXAMPLES.ConversationMessage;
    expect(C.ConversationMessage.parse({ ...message, inputMode: "voice" }).inputMode).toBe("voice");
    expect(C.ConversationMessage.safeParse({ ...message, inputMode: "text" }).success).toBe(false);
    expect(C.ConversationMessage.parse(message)).not.toHaveProperty("inputMode");
  });
});

describe("request access (#357)", () => {
  it.each(["user-x7k2m9qa", "user-00000000"])("accepts the username %s", (username) => {
    expect(C.RequestAccessResponse.safeParse({ ...EXAMPLES.RequestAccessResponse, username }).success).toBe(
      true,
    );
  });

  it.each(["reviewer-x7k2m9qa", "user-X7K2M9QA", "user-x7k2m9q", "user-x7k2m9qab", "maria.santos"])(
    "rejects the username %s, which is not user- and 8 lowercase letters or digits",
    (username) => {
      expect(C.RequestAccessResponse.safeParse({ ...EXAMPLES.RequestAccessResponse, username }).success).toBe(
        false,
      );
    },
  );

  it("takes the bot-check token and nothing else from the reviewer", () => {
    expect(C.RequestAccessRequest.safeParse({ turnstileToken: "t", email: "a@example.com" }).success).toBe(
      false,
    );
    expect(C.RequestAccessRequest.safeParse({ turnstileToken: "" }).success).toBe(false);
    expect(C.RequestAccessRequest.safeParse({ turnstileToken: "x".repeat(2048) }).success).toBe(true);
    expect(C.RequestAccessRequest.safeParse({ turnstileToken: "x".repeat(2049) }).success).toBe(false);
  });

  const response = (changes: Record<string, unknown>) =>
    C.RequestAccessResponse.safeParse({ ...EXAMPLES.RequestAccessResponse, ...changes }).success;

  it("keeps the password between 12 and 64 characters", () => {
    expect(response({ password: "x".repeat(12) })).toBe(true);
    expect(response({ password: "x".repeat(11) })).toBe(false);
    expect(response({ password: "x".repeat(64) })).toBe(true);
    expect(response({ password: "x".repeat(65) })).toBe(false);
  });

  it.each(["firstName", "lastName"])("keeps %s between 1 and 60 characters", (field) => {
    expect(response({ [field]: "x" })).toBe(true);
    expect(response({ [field]: "" })).toBe(false);
    expect(response({ [field]: "x".repeat(60) })).toBe(true);
    expect(response({ [field]: "x".repeat(61) })).toBe(false);
  });

  it("anchors the username at its start: nothing may come before user-", () => {
    expect(response({ username: "xuser-x7k2m9qa" })).toBe(false);
  });

  it("names the one username prefix, user-", () => {
    expect(C.ACCESS_USERNAME_PREFIX).toBe("user-");
  });

  it("cuts the milliseconds off a date, without rounding", () => {
    expect(C.toIsoSeconds(new Date("2026-10-20T14:00:00.999Z"))).toBe("2026-10-20T14:00:00Z");
    expect(C.toIsoSeconds(new Date("2026-10-20T14:00:00.000Z"))).toBe("2026-10-20T14:00:00Z");
  });

  it("takes a one-character token", () => {
    expect(C.RequestAccessRequest.safeParse({ turnstileToken: "x" }).success).toBe(true);
  });

  it("keeps an error message between 1 and 500 characters", () => {
    const error = (message: string) =>
      C.RequestAccessError.safeParse({ error: { code: "TRY_AGAIN", message } }).success;
    expect(error("x")).toBe(true);
    expect(error("")).toBe(false);
    expect(error("x".repeat(500))).toBe(true);
    expect(error("x".repeat(501))).toBe(false);
  });

  it("names exactly the four codes this route answers with, and each one's status and message", () => {
    expect(C.RequestAccessErrorCode.options).toEqual([
      "BAD_REQUEST",
      "BOT_CHECK_FAILED",
      "CAP_REACHED",
      "TRY_AGAIN",
    ]);
    expect(C.ACCESS_CAP_MESSAGE).toBe(
      "Demo access requests have run out for now. Please contact Nick through the contact details in the project README.",
    );
    expect(Object.fromEntries(Object.entries(C.ACCESS_ERRORS).map(([k, v]) => [k, v.status]))).toEqual({
      BAD_REQUEST: 400,
      BOT_CHECK_FAILED: 403,
      CAP_REACHED: 429,
      TRY_AGAIN: 503,
    });
    expect(Object.fromEntries(Object.entries(C.ACCESS_ERRORS).map(([k, v]) => [k, v.message]))).toEqual({
      BAD_REQUEST: "The request body must be a bot-check token.",
      BOT_CHECK_FAILED: "The check didn't pass. Please try again.",
      CAP_REACHED: C.ACCESS_CAP_MESSAGE,
      TRY_AGAIN: "We couldn't create access just now. Please try again in a moment.",
    });
  });
});
