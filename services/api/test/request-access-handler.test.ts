/**
 * The Lambda entry point's wiring (`handlers/request-access.ts`): the environment's caps and pool, the Turnstile
 * call, the clock and the Powertools logger. The DynamoDB store and the User Pool adapter are replaced with
 * in-memory ones; Cloudflare is a stubbed `fetch` (Cloudflare's documented dummy token and test secrets); the rest is real.
 */
import { RequestAccessError, RequestAccessResponse } from "@sched/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RestApiProxyEvent } from "../src";
import type * as AccessStoreModule from "../src/lib/access-store";

const wiring = vi.hoisted(() => ({
  storeOptions: [] as unknown[],
  poolIds: [] as string[],
  users: new Set<string>(),
}));

vi.mock("../src/lib/access-store", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & typeof AccessStoreModule>();
  return {
    ...actual,
    createDynamoAccessStore: (options: unknown) => {
      wiring.storeOptions.push(options);
      return actual.createInMemoryAccessStore();
    },
  };
});

vi.mock("../src/lib/cognito-admin", () => ({
  cognitoAdmin: (_client: unknown, poolId: string) => {
    wiring.poolIds.push(poolId);
    return {
      createUser: (user: { username: string }) => {
        wiring.users.add(user.username);
        return Promise.resolve(true);
      },
      setPermanentPassword: () => Promise.resolve(),
      getSub: () => Promise.resolve("3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01"),
      deleteUser: () => Promise.resolve(),
    };
  },
}));

const PASS_SECRET = "1x0000000000000000000000000000000AA";
const event: RestApiProxyEvent = {
  body: JSON.stringify({ turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }),
  requestContext: { requestId: "req-1" },
};

let siteverify: ReturnType<typeof vi.fn>;

beforeEach(() => {
  wiring.storeOptions.length = 0;
  wiring.poolIds.length = 0;
  wiring.users.clear();
  vi.resetModules();
  vi.stubEnv("TABLE_NAME", "sched-test-table");
  vi.stubEnv("USER_POOL_ID", "pool-a");
  vi.stubEnv("TURNSTILE_SECRET", PASS_SECRET);
  vi.stubEnv("ACCESS_DAILY_CAP", "1");
  siteverify = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ success: true, hostname: "localhost" }))),
  );
  vi.stubGlobal("fetch", siteverify);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handlers/request-access", () => {
  it("wires the table, the pool and the secret, issues an account and logs only the outcome", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => out.push(String(chunk)) > 0);
    const { handler } = await import("../src/handlers/request-access");

    const res = await handler(event, {
      functionName: "sched-test-api-request-access",
      awsRequestId: "lambda-req-1",
    });

    expect(res.statusCode).toBe(200);
    const body = RequestAccessResponse.parse(JSON.parse(res.body));
    expect(wiring.users).toEqual(new Set([body.username]));
    expect(wiring.storeOptions).toEqual([expect.objectContaining({ tableName: "sched-test-table" })]);
    expect(wiring.poolIds).toEqual(["pool-a"]);
    // The verifier posted the secret and the token, and no address.
    const [url, init] = siteverify.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(JSON.parse(String(init.body))).toEqual({ secret: PASS_SECRET, response: "XXXX.DUMMY.TOKEN.XXXX" });
    const lines = out.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      expect.objectContaining({
        message: "request-access",
        service: "request-access",
        requestId: "req-1",
        outcome: "issued",
        function_request_id: "lambda-req-1",
      }),
    ]);
    for (const secret of [body.username, body.password, PASS_SECRET, "XXXX.DUMMY.TOKEN.XXXX"]) {
      expect(out.join("")).not.toContain(secret);
    }
  });

  it("reads the daily cap from ACCESS_DAILY_CAP: the second request in a day gets the contact message", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { handler } = await import("../src/handlers/request-access");
    expect((await handler(event)).statusCode).toBe(200);
    const second = await handler(event);
    expect(second.statusCode).toBe(429);
    expect(RequestAccessError.parse(JSON.parse(second.body)).error.code).toBe("CAP_REACHED");
    expect(wiring.users.size).toBe(1);
  });

  it("reads the expiry from ACCESS_EXPIRY_HOURS", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("ACCESS_EXPIRY_HOURS", "2");
    const { handler } = await import("../src/handlers/request-access");
    const before = Date.now();
    const body = RequestAccessResponse.parse(JSON.parse((await handler(event)).body));
    const hours = (Date.parse(body.expiresAt) - before) / 3_600_000;
    expect(hours).toBeGreaterThan(1.99);
    expect(hours).toBeLessThan(2.01);
  });

  it("checks Cloudflare's hostname when TURNSTILE_EXPECTED_HOSTNAME is set", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.stubEnv("TURNSTILE_EXPECTED_HOSTNAME", "demo.example");
    const { handler } = await import("../src/handlers/request-access");
    const res = await handler(event);
    expect(res.statusCode).toBe(403);
    expect(wiring.users.size).toBe(0);
  });

  it.each(["TABLE_NAME", "USER_POOL_ID", "TURNSTILE_SECRET"])(
    "fails the cold start without %s",
    async (name) => {
      vi.stubEnv(name, "");
      await expect(import("../src/handlers/request-access")).rejects.toThrow(new RegExp(name));
    },
  );
});
