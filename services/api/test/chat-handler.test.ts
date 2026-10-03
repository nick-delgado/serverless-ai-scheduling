/**
 * The Lambda entry point's wiring (`handlers/chat.ts`): config from the environment, the AWS stores, the
 * Converse client and the console logger. The AWS stores and the Converse client are replaced with
 * in-memory and scripted stand-ins; everything else is the real module.
 */
import { PassThrough } from "node:stream";

import type * as Agent from "@sched/agent";
import { parseChatResponseBody } from "@sched/contracts";
import { createInMemoryRepositories } from "@sched/tools";
import { FIXTURE_PATIENT_IDS, buildClinicFixture } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInMemoryTurnStore, type RestApiProxyEvent } from "../src";

const aws = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("../src/lib/aws", () => ({
  createAwsStores: (options: { tableName: string; clock: never }) => {
    aws.calls.push(options);
    return {
      repos: createInMemoryRepositories({ clock: options.clock, seed: buildClinicFixture() }),
      turns: createInMemoryTurnStore(),
    };
  },
}));

vi.mock("@sched/agent", async (importOriginal) => {
  const agent = await importOriginal<typeof Agent>();
  return {
    ...agent,
    ConverseLlmClient: class extends agent.ScriptedLlmClient {
      constructor() {
        super([agent.scriptedText("Hi!"), agent.scriptedText("Hi again!")]);
      }
    },
  };
});

const MARIA = FIXTURE_PATIENT_IDS["pat-maria"];
const event: RestApiProxyEvent = {
  body: JSON.stringify({ clientMessageId: "5b8e2c1a-7d6f-4e3b-9a1c-2d3e4f5a6b7c", text: "Hello" }),
  requestContext: { requestId: "req-1", authorizer: { claims: { sub: MARIA } } },
};

beforeEach(() => {
  aws.calls.length = 0;
  vi.resetModules();
  vi.stubGlobal("awslambda", {
    streamifyResponse: <T>(handler: T) => handler,
    HttpResponseStream: { from: (stream: awslambda.ResponseStream) => stream },
  });
  vi.stubEnv("TABLE_NAME", "sched-test-table");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function invoke(handler: awslambda.StreamifyHandler<RestApiProxyEvent>) {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  await handler(event, stream, {});
  return parseChatResponseBody(Buffer.concat(chunks).toString("utf8"));
}

describe("handlers/chat", () => {
  it("builds the stores from TABLE_NAME and logs each turn through the console", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { handler } = await import("../src/handlers/chat");

    const events = await invoke(handler);
    expect(events.at(-1)?.type).toBe("done");
    expect(aws.calls).toEqual([expect.objectContaining({ tableName: "sched-test-table" })]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ msg: "chat turn", terminal: "done" }));
  });

  it("applies DAILY_TURN_CAP from the environment", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubEnv("DAILY_TURN_CAP", "1");
    const { handler } = await import("../src/handlers/chat");

    expect((await invoke(handler)).at(-1)?.type).toBe("done");
    expect((await invoke(handler)).at(-1)).toMatchObject({
      type: "error",
      code: "RATE_LIMITED",
      retryable: false,
    });
  });
});
