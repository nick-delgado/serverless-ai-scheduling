/**
 * The Lambda entry point's wiring (`handlers/session.ts`): TABLE_NAME, the AWS stores, the system clock
 * and the Powertools logger with the Lambda context (#38, A-7). The AWS stores are replaced with in-memory ones; everything else is real.
 */
import { SessionResponse } from "@sched/contracts";
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

const event: RestApiProxyEvent = {
  body: "{}",
  requestContext: { requestId: "req-1", authorizer: { claims: { sub: FIXTURE_PATIENT_IDS["pat-maria"] } } },
};

beforeEach(() => {
  aws.calls.length = 0;
  vi.resetModules();
  vi.stubEnv("TABLE_NAME", "sched-test-table");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("handlers/session", () => {
  it("builds the stores from TABLE_NAME and logs each call through Powertools with the Lambda request ID", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => out.push(String(chunk)) > 0);
    const { handler } = await import("../src/handlers/session");

    const res = await handler(event, {
      functionName: "sched-test-api-session",
      awsRequestId: "lambda-req-2",
    });
    expect(res.statusCode).toBe(200);
    expect(SessionResponse.parse(JSON.parse(res.body)).patient.firstName).toBe("Maria");
    expect(aws.calls).toEqual([expect.objectContaining({ tableName: "sched-test-table" })]);
    expect(out.map((l) => JSON.parse(l) as unknown)).toEqual([
      expect.objectContaining({
        message: "session",
        service: "session",
        requestId: "req-1",
        status: 200,
        function_request_id: "lambda-req-2",
      }),
    ]);
  });

  it("uses the real clock to decide what is upcoming", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["Date"] });
    const { handler } = await import("../src/handlers/session");

    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    const before = SessionResponse.parse(JSON.parse((await handler(event)).body));
    expect(before.upcomingAppointment?.startLocal).toBe("Tuesday, October 13, 2026 at 2:30 PM ET");
    vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const after = SessionResponse.parse(JSON.parse((await handler(event)).body));
    expect(after.upcomingAppointment).toBeNull();
  });

  it("fails the cold start without TABLE_NAME", async () => {
    vi.stubEnv("TABLE_NAME", "");
    await expect(import("../src/handlers/session")).rejects.toThrow(/TABLE_NAME/);
  });
});
