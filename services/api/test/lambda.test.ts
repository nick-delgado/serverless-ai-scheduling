/**
 * The Lambda adapter (`lib/lambda.ts`) over a fake `awslambda` global: claims → patient, body decoding,
 * the status/headers prelude, the stream being ended, and the deadline signal.
 */
import { PassThrough } from "node:stream";

import { ScriptedLlmClient, resolveModelProfile, scriptedText, type ScriptedStep } from "@sched/agent";
import { parseChatResponseBody } from "@sched/contracts";
import { FrozenClock, createInMemoryRepositories } from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInMemoryTurnStore,
  NDJSON_HEADERS,
  placeholderSystemPrompt,
  type RestApiProxyEvent,
} from "../src";
import { chatStreamHandler, deadlineSignal, PERSIST_RESERVE_MS } from "../src/lib/lambda";

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const body = JSON.stringify({ clientMessageId: "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c", text: "Hello" });

let preludes: awslambda.HttpResponseMetadata[];

beforeEach(() => {
  preludes = [];
  vi.stubGlobal("awslambda", {
    HttpResponseStream: {
      from(stream: awslambda.ResponseStream, metadata: awslambda.HttpResponseMetadata) {
        preludes.push(metadata);
        return stream;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function event(overrides: Partial<RestApiProxyEvent> & { sub?: string } = {}): RestApiProxyEvent {
  const { sub = MARIA, ...rest } = overrides;
  return { body, requestContext: { requestId: "req-1", authorizer: { claims: { sub } } }, ...rest };
}

async function invoke(
  e: RestApiProxyEvent,
  { context = {}, steps = [scriptedText("Hi!")] }: { context?: unknown; steps?: ScriptedStep[] } = {},
) {
  const clock = new FrozenClock("2026-10-05T13:00:00Z");
  const llm = new ScriptedLlmClient(steps);
  const handler = chatStreamHandler({
    repos: createInMemoryRepositories({ clock, seed: buildClinicFixture() }),
    turns: createInMemoryTurnStore(),
    llm,
    profile: resolveModelProfile("sonnet-4.6"),
    clock,
    systemPrompt: placeholderSystemPrompt,
    dailyTurnCap: 50,
  });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  await handler(e, stream, context);
  return {
    events: parseChatResponseBody(Buffer.concat(chunks).toString("utf8")),
    llm,
    ended: stream.writableEnded,
  };
}

describe("chatStreamHandler", () => {
  it("streams NDJSON with a 200 prelude for the authorizer's sub", async () => {
    const { events, ended } = await invoke(event());
    expect(preludes).toEqual([{ statusCode: 200, headers: { ...NDJSON_HEADERS } }]);
    expect(events.at(-1)?.type).toBe("done");
    expect(ended).toBe(true);
  });

  it("decodes a base64 body", async () => {
    const { events } = await invoke(
      event({ body: Buffer.from(body).toString("base64"), isBase64Encoded: true }),
    );
    expect(events.at(-1)?.type).toBe("done");
  });

  it.each([
    ["no authorizer", { requestContext: { requestId: "r", authorizer: null } }],
    ["a non-UUID sub", { sub: "admin" }],
  ])("answers 401 with %s", async (_name, overrides) => {
    const { events, llm, ended } = await invoke(event(overrides));
    expect(preludes[0]?.statusCode).toBe(401);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "UNAUTHORIZED" })]);
    expect(llm.requests).toHaveLength(0);
    expect(ended).toBe(true);
  });

  describe("with a Lambda context", () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
    afterEach(() => vi.useRealTimers());

    it("passes the deadline to the turn: a model call still running at the deadline ends in AGENT_UNAVAILABLE", async () => {
      // The deadline fires 1 s in (the floor); the model call starts before that and answers after 5 s.
      let started!: () => void;
      const modelCalled = new Promise<void>((resolve) => (started = resolve));
      const slow: ScriptedStep = () => {
        started();
        return new Promise((resolve) => setTimeout(() => resolve(scriptedText("Too late.")), 5_000));
      };
      const running = invoke(event(), {
        context: { getRemainingTimeInMillis: () => PERSIST_RESERVE_MS },
        steps: [slow],
      });
      await modelCalled;
      await vi.advanceTimersByTimeAsync(5_000);
      const { events, ended } = await running;

      expect(events.at(-1)).toMatchObject({ type: "error", code: "AGENT_UNAVAILABLE" });
      expect(ended).toBe(true);
    });

    it("cancels the deadline timer when the turn ends first", async () => {
      const { events } = await invoke(event(), { context: { getRemainingTimeInMillis: () => 180_000 } });
      expect(events.at(-1)?.type).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("deadlineSignal", () => {
  it("fires PERSIST_RESERVE_MS before the function's deadline", () => {
    vi.useFakeTimers();
    try {
      const deadline = deadlineSignal({ getRemainingTimeInMillis: () => PERSIST_RESERVE_MS + 5_000 });
      vi.advanceTimersByTime(4_999);
      expect(deadline?.signal.aborted).toBe(false);
      vi.advanceTimersByTime(2);
      expect(deadline?.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the loop at least a second, and nothing without a Lambda context", () => {
    vi.useFakeTimers();
    try {
      const deadline = deadlineSignal({ getRemainingTimeInMillis: () => 100 });
      vi.advanceTimersByTime(999);
      expect(deadline?.signal.aborted).toBe(false);
      vi.advanceTimersByTime(2);
      expect(deadline?.signal.aborted).toBe(true);
      expect(deadlineSignal({})).toBeUndefined();
      expect(deadlineSignal(undefined)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
