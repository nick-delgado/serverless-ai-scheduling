import { ScriptedLlmClient, scriptedText, type LlmRequest } from "@sched/agent";
import { describe, expect, it } from "vitest";

import {
  defaultRpmFor,
  isRetryable,
  isThrottle,
  RateLimitedLlmClient,
  RateLimiter,
  TokenBucket,
  type Timer,
} from "../src";

/** A virtual clock: `sleep` advances time instead of waiting. */
function fakeTimer(): Timer & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

const request = (modelId: string): LlmRequest => ({
  modelId,
  family: "openai.gpt-oss",
  system: [],
  tools: [],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  maxTokens: 100,
  modelFields: {},
});

const throttle = () =>
  Object.assign(new Error("Too many requests"), {
    name: "ThrottlingException",
    $metadata: { httpStatusCode: 429 },
  });

describe("TokenBucket", () => {
  it("paces calls to the rate", async () => {
    const timer = fakeTimer();
    const bucket = new TokenBucket(10, { timer }); // one token every 6 s
    for (let i = 0; i < 4; i++) await bucket.take();
    expect(timer.now()).toBe(18_000);
  });
});

describe("RateLimiter", () => {
  it("keeps one bucket per model, so a slow model doesn't hold up a fast one", async () => {
    const timer = fakeTimer();
    const limiter = new RateLimiter({ timer, utilization: 1 });
    await limiter.acquire("us.anthropic.claude-sonnet-4-6");
    await limiter.acquire("openai.gpt-oss-20b-1:0");
    expect(timer.now()).toBe(0);
    await limiter.acquire("openai.gpt-oss-20b-1:0");
    expect(timer.now()).toBe(600); // 100 RPM
  });

  it("uses the account quotas from CLAUDE.md", () => {
    expect(defaultRpmFor("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(10);
    expect(defaultRpmFor("us.amazon.nova-pro-v1:0")).toBe(25);
    expect(defaultRpmFor("us.amazon.nova-2-lite-v1:0")).toBe(20);
    expect(defaultRpmFor("openai.gpt-oss-120b-1:0")).toBe(100);
  });
});

describe("RateLimitedLlmClient", () => {
  it("retries a 429 with backoff, drawing a fresh token each attempt", async () => {
    const timer = fakeTimer();
    const inner = new ScriptedLlmClient([{ error: throttle() }, { error: throttle() }, scriptedText("ok")]);
    const client = new RateLimitedLlmClient(inner, {
      limiter: new RateLimiter({ timer, utilization: 1 }),
      baseDelayMs: 1000,
      random: () => 0,
    });
    const response = await client.streamMessage(request("openai.gpt-oss-20b-1:0"));
    expect(response.content).toEqual([{ type: "text", text: "ok" }]);
    expect(client.stats).toEqual({ calls: 3, retries: 2, throttles: 2 });
    // backoff 500 ms (half-jitter floor of 1 s), then 100 ms more for the next token (100 RPM), then backoff 1 s
    expect(timer.sleeps).toEqual([500, 100, 1000]);
  });

  it("does not retry a non-retryable error, and gives up after maxRetries", async () => {
    const timer = fakeTimer();
    const limiter = new RateLimiter({ timer });
    const denied = Object.assign(new Error("no access"), {
      name: "AccessDeniedException",
      $metadata: { httpStatusCode: 403 },
    });
    await expect(
      new RateLimitedLlmClient(new ScriptedLlmClient([{ error: denied }]), { limiter }).streamMessage(
        request("m"),
      ),
    ).rejects.toBe(denied);
    const always = new ScriptedLlmClient([{ error: throttle() }, { error: throttle() }]);
    await expect(
      new RateLimitedLlmClient(always, { limiter, maxRetries: 1 }).streamMessage(request("m")),
    ).rejects.toMatchObject({
      name: "ThrottlingException",
    });
  });

  it("classifies errors", () => {
    expect(isThrottle(throttle())).toBe(true);
    expect(isRetryable(Object.assign(new Error(), { name: "ServiceUnavailableException" }))).toBe(true);
    expect(
      isRetryable(
        Object.assign(new Error(), { name: "ValidationException", $metadata: { httpStatusCode: 400 } }),
      ),
    ).toBe(false);
  });
});
