/**
 * The Powertools log writer (`lib/observability/logger.ts`, owner decision r1/Q-4 (a)) and the per-invocation
 * wrappers (`lib/observability/lambda.ts`, A-5): what a written line looks like, and that the Lambda context
 * comes from a streaming handler's third argument.
 */
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentStreamHandler, withLambdaContext } from "../src/lib/observability/lambda";
import { createPowertoolsLogger, powertoolsLogger } from "../src/lib/observability/logger";
import { envMetrics } from "../src/lib/observability/metrics";

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => out.push(String(chunk)) > 0);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => err.push(String(chunk)) > 0);
});
afterEach(() => vi.restoreAllMocks());

const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

/** A synthetic Lambda context (no real account). */
const context = {
  functionName: "sched-test-api-chat",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:000000000000:function:sched-test-api-chat",
  memoryLimitInMB: "1024",
  awsRequestId: "lambda-req-1",
};

describe("powertoolsLogger", () => {
  it("writes one JSON line per entry: msg as message, the fields at the top level, the service named", () => {
    const log = powertoolsLogger(createPowertoolsLogger("chat"));
    log({ msg: "chat turn", requestId: "req-1", usage: { inputTokens: 3 } });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\{.*\}\n$/);
    const [line] = parsed(out);
    expect(line).toMatchObject({
      level: "INFO",
      message: "chat turn",
      service: "chat",
      requestId: "req-1",
      usage: { inputTokens: 3 },
    });
    expect(line).not.toHaveProperty("msg");
  });

  it("writes at the entry's level", () => {
    const log = powertoolsLogger(createPowertoolsLogger("chat"));
    log({ msg: "a", level: "warn" });
    log({ msg: "b", level: "error", errorName: "TypeError" });

    expect(parsed(err)).toEqual([
      expect.objectContaining({ level: "WARN", message: "a" }),
      expect.objectContaining({ level: "ERROR", message: "b", errorName: "TypeError" }),
    ]);
    expect(out).toEqual([]);
  });
});

describe("instrumentStreamHandler (A-5)", () => {
  it("adds the Lambda context from the third argument, then flushes the stored metrics once", async () => {
    const logger = createPowertoolsLogger("chat");
    const metrics = envMetrics("test-env");
    const log = powertoolsLogger(logger);
    const handler = instrumentStreamHandler<string>(
      async () => {
        log({ msg: "chat turn" });
        metrics.addMetric("Turns", "Count", 1);
        await Promise.resolve();
        expect(out.some((l) => l.includes('"_aws"'))).toBe(false);
      },
      { logger, metrics },
    );

    await handler("event", new PassThrough(), context);

    const [line, record] = parsed(out);
    expect(line).toMatchObject({ message: "chat turn", function_request_id: "lambda-req-1" });
    expect(record).toMatchObject({ Env: "test-env", Turns: 1 });
    expect(out).toHaveLength(2);
  });

  it("flushes the metrics when the handler throws, and rethrows", async () => {
    const metrics = envMetrics("test-env");
    const handler = instrumentStreamHandler<string>(
      () => {
        metrics.addMetric("Turns", "Count", 1);
        return Promise.reject(new Error("boom"));
      },
      { logger: createPowertoolsLogger("chat"), metrics },
    );

    await expect(handler("event", new PassThrough(), context)).rejects.toThrow("boom");
    expect(parsed(out)).toEqual([expect.objectContaining({ Turns: 1 })]);
  });

  it("writes nothing, not even Powertools' empty-metrics warning, when no metric was stored", async () => {
    const handler = instrumentStreamHandler<string>(() => Promise.resolve(), {
      logger: createPowertoolsLogger("chat"),
      metrics: envMetrics("test-env"),
    });

    await handler("event", new PassThrough(), context);
    expect([...out, ...err]).toEqual([]);
  });
});

describe("withLambdaContext", () => {
  it("adds the Lambda context from the second argument and returns the handler's result", async () => {
    const logger = createPowertoolsLogger("session");
    const log = powertoolsLogger(logger);
    const handler = withLambdaContext(logger, (event: string) => {
      log({ msg: "session" });
      return Promise.resolve(`${event}!`);
    });

    await expect(handler("ok", context)).resolves.toBe("ok!");
    expect(parsed(out)).toEqual([
      expect.objectContaining({ message: "session", function_request_id: "lambda-req-1" }),
    ]);
  });

  it("runs without a context (a local call), adding none", async () => {
    const logger = createPowertoolsLogger("session");
    const log = powertoolsLogger(logger);
    const handler = withLambdaContext(logger, () => {
      log({ msg: "session" });
      return Promise.resolve(1);
    });

    await expect(handler("ok")).resolves.toBe(1);
    expect(parsed(out)[0]).not.toHaveProperty("function_request_id");
  });
});
