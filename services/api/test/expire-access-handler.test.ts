/**
 * The expiry job's Lambda entry point (`handlers/expire-access.ts`): the environment's table and pool, the clock, the
 * Powertools logger and the event. The DynamoDB store, the data deleter and the User Pool adapter are replaced; the
 * rules are `expire-access.test.ts` and the real tables `expire-access.local.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExpireDeps } from "../src/lib/expire-access";

const wiring = vi.hoisted(() => ({
  storeTables: [] as string[],
  dataTables: [] as string[],
  poolIds: [] as string[],
  listed: [] as string[],
  deleted: [] as string[],
  entries: [] as { requestId: string; username: string; accessExpiresAt: string; sub?: string }[],
}));

vi.mock("../src/lib/access-store", () => ({
  createDynamoAccessStore: (options: { tableName: string }) => {
    wiring.storeTables.push(options.tableName);
    return {
      listExpired: (now: string) => {
        wiring.listed.push(now);
        return Promise.resolve(wiring.entries);
      },
      release: () => Promise.resolve({ ok: true }),
    } satisfies ExpireDeps["store"];
  },
}));

vi.mock("../src/lib/account-data", () => ({
  createAccountData: (options: { tableName: string }) => {
    wiring.dataTables.push(options.tableName);
    return { deleteAccount: () => Promise.resolve({ items: 2, slotsFreed: 1 }) };
  },
}));

vi.mock("../src/lib/cognito-admin", () => ({
  cognitoAdmin: (_client: unknown, poolId: string) => {
    wiring.poolIds.push(poolId);
    return {
      findSub: (username: string) =>
        Promise.resolve(wiring.entries.find((e) => e.username === username)?.sub),
      globalSignOut: () => Promise.resolve(),
      deleteUser: (username: string) => {
        wiring.deleted.push(username);
        return Promise.resolve();
      },
    };
  },
}));

const SUB = "11111111-1111-4111-8111-000000000001";

beforeEach(() => {
  for (const list of Object.values(wiring)) list.length = 0;
  wiring.entries.push({
    requestId: "00000000-0000-4000-8000-000000000001",
    username: "user-00000001",
    accessExpiresAt: "2026-10-21T14:00:00Z",
    sub: SUB,
  });
  vi.resetModules();
  vi.stubEnv("TABLE_NAME", "sched-test-table");
  vi.stubEnv("USER_POOL_ID", "pool-a");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("handlers/expire-access", () => {
  it("wires the table and the pool, runs as of now for the schedule's event, and logs counts with the request ID", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => out.push(String(chunk)) > 0);
    const before = Date.now();
    const { handler } = await import("../src/handlers/expire-access");

    const summary = await handler(
      { source: "aws.events", "detail-type": "Scheduled Event" },
      { functionName: "sched-test-api-request-access-expiry", awsRequestId: "lambda-req-1" },
    );

    expect(summary).toMatchObject({ due: 1, expired: 1, failed: 0 });
    expect(Date.parse(summary.asOf)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(wiring.storeTables).toEqual(["sched-test-table"]);
    expect(wiring.dataTables).toEqual(["sched-test-table"]);
    expect(wiring.poolIds).toEqual(["pool-a"]);
    expect(wiring.deleted).toEqual(["user-00000001"]);
    const lines = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({
      message: "access-expiry",
      service: "expire-access",
      function_request_id: "lambda-req-1",
      due: 1,
      expired: 1,
    });
    for (const hidden of ["user-00000001", SUB]) expect(out.join("")).not.toContain(hidden);
  });

  it("runs as of the event's asOf", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { handler } = await import("../src/handlers/expire-access");
    await handler({ asOf: "2031-01-01T00:00:00Z" });
    expect(wiring.listed).toEqual(["2031-01-01T00:00:00Z"]);
  });

  it.each(["TABLE_NAME", "USER_POOL_ID"])("fails the cold start without %s", async (name) => {
    vi.stubEnv(name, "");
    await expect(import("../src/handlers/expire-access")).rejects.toThrow(new RegExp(name));
  });
});
