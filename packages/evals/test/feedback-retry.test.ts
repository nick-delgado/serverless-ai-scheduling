/**
 * `callWithFeedback` (#105): the retry-with-feedback loop the simulator and the judge share. Each
 * behaviour is pinned here with a scripted model; the simulator's and judge's own tests still cover
 * their wiring.
 */
import {
  estimateCostUsd,
  MODEL_PROFILES,
  ScriptedLlmClient,
  scriptedMaxTokens,
  scriptedText,
  type LlmRequest,
} from "@sched/agent";
import { describe, expect, it } from "vitest";

import { callWithFeedback, type FeedbackRetryOptions } from "../src/feedback-retry";
import type { RejectedReply, SimulatorCost } from "../src/simulator/types";

const profile = MODEL_PROFILES["sonnet-4.6"];

class TestError extends Error {
  constructor(
    message: string,
    readonly cost: SimulatorCost,
    readonly rejected: RejectedReply[],
  ) {
    super(message);
  }
}

/** The options under test, recording the rejected replies each request was built from. */
function setup(llm: ScriptedLlmClient, maxAttempts = 3) {
  const seen: RejectedReply[][] = [];
  const options: FeedbackRetryOptions<string> = {
    llm,
    profile,
    maxAttempts,
    request: (rejected): LlmRequest => {
      seen.push(structuredClone([...rejected]));
      return {
        modelId: profile.modelId,
        family: profile.family,
        system: [{ type: "text", text: "sys" }],
        tools: [],
        messages: [{ role: "user", content: [{ type: "text", text: `attempt ${String(seen.length)}` }] }],
        maxTokens: 10,
        modelFields: {},
      };
    },
    parse: (text) =>
      text.startsWith("good")
        ? { ok: true, value: text }
        : { ok: false, problems: [`"${text}" is bad`, "again"] },
    error: (message, cost, rejected) => new TestError(message, cost, rejected),
    exhausted: "nothing usable in 3",
  };
  return { options, seen };
}

const usage = (inputTokens: number, outputTokens: number) => ({ usage: { inputTokens, outputTokens } });

async function failure(promise: Promise<unknown>): Promise<TestError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof TestError)) throw new Error(`expected a TestError, got ${String(error)}`);
  return error;
}

describe("callWithFeedback (#105)", () => {
  it("returns the first accepted reply, its cost, and no rejected key", async () => {
    const llm = new ScriptedLlmClient([scriptedText("good one", usage(100, 20))]);
    const { options, seen } = setup(llm);

    const result = await callWithFeedback(options);

    expect(result).toEqual({
      value: "good one",
      cost: {
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costUsd: estimateCostUsd(profile, {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        llmCalls: 1,
      },
    });
    expect(Object.keys(result)).not.toContain("rejected");
    expect(seen).toEqual([[]]);
    expect(llm.requests[0]?.messages[0]?.content).toEqual([{ type: "text", text: "attempt 1" }]);
  });

  it("feeds the rejected replies back, records them, and sums the cost of every attempt", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText("bad", usage(100, 10)),
      scriptedText("good", usage(200, 30)),
    ]);
    const { options, seen } = setup(llm);

    const result = await callWithFeedback(options);

    const bad = { reply: "bad", problems: ['"bad" is bad', "again"] };
    expect(seen).toEqual([[], [bad]]);
    expect(result.value).toBe("good");
    expect(result.rejected).toEqual([bad]);
    const summed = { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(result.cost).toEqual({ usage: summed, costUsd: estimateCostUsd(profile, summed), llmCalls: 2 });
  });

  it("rejects a reply that didn't end with end_turn, without parsing it", async () => {
    const llm = new ScriptedLlmClient([
      scriptedMaxTokens({ partialText: "good but cut" }),
      scriptedText("good"),
    ]);
    const { options } = setup(llm);

    const result = await callWithFeedback(options);

    expect(result.rejected).toEqual([
      { reply: "good but cut", problems: ["the model stopped with max_tokens"] },
    ]);
  });

  it("makes exactly maxAttempts calls, then throws the caller's error with every problem and the cost", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText("one", usage(1, 1)),
      scriptedText("two", usage(2, 2)),
      scriptedText("three", usage(3, 3)),
      scriptedText("good, but too late"),
    ]);
    const { options } = setup(llm, 3);

    const error = await failure(callWithFeedback(options));

    expect(error.message).toBe(
      'nothing usable in 3: "one" is bad, again | "two" is bad, again | "three" is bad, again',
    );
    expect(llm.remaining).toBe(1);
    expect(error.rejected.map((r) => r.reply)).toEqual(["one", "two", "three"]);
    const summed = { inputTokens: 6, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(error.cost).toEqual({ usage: summed, costUsd: estimateCostUsd(profile, summed), llmCalls: 3 });
  });

  it("stops at a model call that throws, carrying what the earlier attempts cost", async () => {
    const llm = new ScriptedLlmClient([
      scriptedText("bad", usage(100, 10)),
      { error: Object.assign(new Error("slow down"), { name: "ThrottlingException" }) },
      scriptedText("good"),
    ]);
    const { options } = setup(llm);

    const error = await failure(callWithFeedback(options));

    expect(error.message).toBe("model call failed: ThrottlingException: slow down");
    expect(llm.remaining).toBe(1);
    expect(error.rejected).toEqual([{ reply: "bad", problems: ['"bad" is bad', "again"] }]);
    expect(error.cost.llmCalls).toBe(1);
    expect(error.cost.usage.inputTokens).toBe(100);
  });
});
