/**
 * `POST /api/request-access` (#357): the issuance core with an injected bot check, in-memory store, fake User Pool
 * and frozen clock. Covers the order of the steps, both caps, the bot check's rejection path, a failure after the
 * reservation, the one username retry, the response and what the log may carry.
 */
import {
  ACCESS_CAP_MESSAGE,
  ACCESS_ERRORS,
  ACCESS_USERNAME_PREFIX,
  Patient,
  RequestAccessError,
  RequestAccessResponse,
} from "@sched/contracts";
import { FrozenClock } from "@sched/tools";
import { buildClinicFixture } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import { type RandomInt } from "../src/lib/access-identity";
import { createInMemoryAccessStore, type AccessStore } from "../src/lib/access-store";
import type { BotCheckResult, BotVerifier } from "../src/lib/bot-check";
import { type CognitoAdmin, passwordProblems } from "../src/lib/cognito-admin";
import {
  DEFAULT_ACCESS_ACTIVE_CAP,
  DEFAULT_ACCESS_DAILY_CAP,
  DEFAULT_ACCESS_EXPIRY_HOURS,
  handleRequestAccess,
  requestAccessProxyHandler,
  type RequestAccessDeps,
} from "../src/lib/issue-access";
import type { LogEntry } from "../src/lib/log";

const NOW = "2026-10-20T14:00:00Z";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const BODY = JSON.stringify({ turnstileToken: TOKEN });
const SUB = "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01";

/** A repeating draw sequence so usernames are predictable: handle "aaaaaaaa", then "bbbbbbbb", and so on. */
function counting(): RandomInt {
  let calls = 0;
  return (max) => Math.floor(calls++ / 8) % max;
}

interface Fixture {
  deps: RequestAccessDeps;
  store: ReturnType<typeof createInMemoryAccessStore>;
  steps: string[];
  logs: LogEntry[];
  users: Map<string, { password?: string }>;
  verifierCalls: string[];
}

function setup(
  options: {
    verdict?: BotCheckResult;
    caps?: { daily: number; active: number };
    admin?: Partial<CognitoAdmin>;
    store?: Partial<AccessStore>;
  } = {},
): Fixture {
  const store = createInMemoryAccessStore();
  const steps: string[] = [];
  const logs: LogEntry[] = [];
  const verifierCalls: string[] = [];
  const users = new Map<string, { password?: string }>();
  const admin: CognitoAdmin = {
    createUser(user) {
      steps.push("createUser");
      if (users.has(user.username)) return Promise.resolve(false);
      users.set(user.username, {});
      return Promise.resolve(true);
    },
    setPermanentPassword(username, password) {
      steps.push("setPermanentPassword");
      const user = users.get(username);
      if (!user) return Promise.reject(new Error("no user"));
      user.password = password;
      return Promise.resolve();
    },
    getSub() {
      steps.push("getSub");
      return Promise.resolve(SUB);
    },
    deleteUser(username) {
      steps.push(`deleteUser:${username}`);
      users.delete(username);
      return Promise.resolve();
    },
    ...options.admin,
  };
  const verifier: BotVerifier = (token) => {
    verifierCalls.push(token);
    steps.push("verify");
    return Promise.resolve(options.verdict ?? { ok: true });
  };
  const deps: RequestAccessDeps = {
    verifier,
    store: {
      reserve: (...args) => {
        steps.push("reserve");
        return (options.store?.reserve ?? store.reserve.bind(store))(...args);
      },
      commit: (...args) => {
        steps.push("commit");
        return (options.store?.commit ?? store.commit.bind(store))(...args);
      },
    },
    admin,
    clock: new FrozenClock(NOW),
    config: { caps: options.caps ?? { daily: 10, active: 5 }, expiryHours: 24 },
    random: counting(),
    newRequestId: (() => {
      let n = 0;
      return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    log: (entry) => logs.push(entry),
    // Two reads per request (start and end), 12.4 ms apart: the log rounds the difference.
    monotonicNow: (() => {
      let t = 100;
      return () => (t += 12.4);
    })(),
  };
  return { deps, store, steps, logs, users, verifierCalls };
}

const call = (f: Fixture, body: string | null = BODY) =>
  handleRequestAccess({ body, requestId: "req-1" }, f.deps);

describe("issuing an account", () => {
  it("runs verify, reserve, create, set password, read the sub, then commit, in that order", async () => {
    const f = setup();
    const res = await call(f);
    expect(res.statusCode).toBe(200);
    expect(f.steps).toEqual(["verify", "reserve", "createUser", "setPermanentPassword", "getSub", "commit"]);
  });

  it("answers with the username, a policy-valid password, the synthetic name and the expiry, uncacheable", async () => {
    const f = setup();
    const res = await call(f);
    const body = RequestAccessResponse.parse(JSON.parse(res.body));
    expect(body).toMatchObject({
      username: "user-aaaaaaaa",
      firstName: expect.any(String),
      lastName: expect.any(String),
      expiresAt: "2026-10-21T14:00:00Z",
    });
    expect(passwordProblems(body.password)).toEqual([]);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    // The password in the response is the one set on the user.
    expect(f.users.get(body.username)?.password).toBe(body.password);
  });

  it("keys the registry entry on the request ID it was given", async () => {
    const f = setup();
    await call(f);
    expect(f.store.issued[0]?.requestId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("writes a profile the Patient contract accepts, keyed on the sub, with the same name the page shows", async () => {
    const f = setup();
    const body = RequestAccessResponse.parse(JSON.parse((await call(f)).body));
    expect(f.store.patients).toHaveLength(1);
    const patient = Patient.parse(f.store.patients[0]);
    expect(patient).toMatchObject({
      patientId: SUB,
      firstName: body.firstName,
      lastName: body.lastName,
      createdAt: NOW,
    });
    expect(f.store.issued).toMatchObject([
      { username: body.username, sub: SUB, accessExpiresAt: body.expiresAt },
    ]);
  });

  it("creates the Cognito user with the patient's synthetic name and nothing about the reviewer", async () => {
    const created: unknown[] = [];
    const f = setup({
      admin: {
        createUser: (user) => {
          created.push(user);
          return Promise.resolve(true);
        },
        setPermanentPassword: () => Promise.resolve(),
      },
    });
    const body = RequestAccessResponse.parse(JSON.parse((await call(f)).body));
    expect(created).toEqual([
      { username: body.username, givenName: body.firstName, familyName: body.lastName },
    ]);
  });

  it("gives a username with the temporary prefix, which no fixture patient's has", async () => {
    const f = setup();
    const body = RequestAccessResponse.parse(JSON.parse((await call(f)).body));
    const fixture = buildClinicFixture().patients.map((p) => `${p.firstName}.${p.lastName}`.toLowerCase());
    expect(fixture).not.toContain(body.username);
    expect(body.username.startsWith(ACCESS_USERNAME_PREFIX)).toBe(true);
  });

  it("dates the daily count by the clinic-local day, not the UTC day", async () => {
    // 2026-10-21T02:00Z is still 2026-10-20 in New York (EDT).
    const f = setup();
    (f.deps.clock as FrozenClock).set("2026-10-21T02:00:00Z");
    await call(f);
    expect(f.store.dailyCount("2026-10-20")).toBe(1);
    expect(f.store.dailyCount("2026-10-21")).toBe(0);
  });
});

describe("the defaults and the expiry time", () => {
  it("defaults to 10 a day, 5 at once and 24 hours", () => {
    expect([DEFAULT_ACCESS_DAILY_CAP, DEFAULT_ACCESS_ACTIVE_CAP, DEFAULT_ACCESS_EXPIRY_HOURS]).toEqual([
      10, 5, 24,
    ]);
  });

  it("dates the expiry exactly the configured hours after the request, to the second", async () => {
    // 14:00:00.990 plus 24 hours is 14:00:00.990 the next day, which is whole second :00; plus 24 ms more would be :01.
    const f = setup();
    (f.deps.clock as FrozenClock).set("2026-10-20T14:00:00.990Z");
    f.deps.config = { ...f.deps.config, expiryHours: 24 };
    const body = RequestAccessResponse.parse(JSON.parse((await call(f)).body));
    expect(body.expiresAt).toBe("2026-10-21T14:00:00Z");
    expect(f.store.issued[0]?.accessExpiresAt).toBe("2026-10-21T14:00:00Z");
    expect(f.store.patients[0]?.createdAt).toBe("2026-10-20T14:00:00Z");
  });

  it("uses the configured number of hours", async () => {
    const f = setup();
    f.deps.config = { ...f.deps.config, expiryHours: 1 };
    const body = RequestAccessResponse.parse(JSON.parse((await call(f)).body));
    expect(body.expiresAt).toBe("2026-10-20T15:00:00Z");
  });

  it("runs with only the required dependencies: real randomness, a UUID request ID, a silent log", async () => {
    const f = setup();
    const { random: _random, newRequestId: _id, log: _log, monotonicNow: _now, ...required } = f.deps;
    const res = await handleRequestAccess({ body: BODY, requestId: "req-1" }, required);
    expect(res.statusCode).toBe(200);
    const body = RequestAccessResponse.parse(JSON.parse(res.body));
    expect(body.username).toMatch(/^user-[a-z0-9]{8}$/);
    expect(f.store.issued[0]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(f.logs).toEqual([]);
  });
});

describe("the bot check", () => {
  it("rejects a request the verifier rejects: 403, nothing created, no cap used", async () => {
    const f = setup({ verdict: { ok: false, reason: "rejected" } });
    const res = await call(f);
    expect(res.statusCode).toBe(403);
    expect(RequestAccessError.parse(JSON.parse(res.body)).error.code).toBe("BOT_CHECK_FAILED");
    expect(f.steps).toEqual(["verify"]);
    expect(f.store.issued).toHaveLength(0);
    expect(f.store.dailyCount("2026-10-20")).toBe(0);
    expect(f.users.size).toBe(0);
  });

  it("fails closed when the verifier is unavailable: 503 try again, not the contact-Nick message", async () => {
    const f = setup({ verdict: { ok: false, reason: "unavailable" } });
    const res = await call(f);
    expect(res.statusCode).toBe(503);
    const error = RequestAccessError.parse(JSON.parse(res.body)).error;
    expect(error.code).toBe("TRY_AGAIN");
    expect(error.message).not.toContain("contact");
    expect(f.steps).toEqual(["verify"]);
    expect(f.store.issued).toHaveLength(0);
  });

  it("gives the verifier the token from the body", async () => {
    const f = setup();
    await call(f);
    expect(f.verifierCalls).toEqual([TOKEN]);
  });

  it("runs before the caps are touched, even when a cap is already reached", async () => {
    const f = setup({ verdict: { ok: false, reason: "rejected" }, caps: { daily: 1, active: 1 } });
    // Use up this fixture's own caps, so a request that reached them would answer 429.
    await f.store.reserve(
      {
        requestId: "11111111-1111-4111-8111-111111111111",
        username: "user-zzzzzzzz",
        day: "2026-10-20",
        accessExpiresAt: "2026-10-21T14:00:00Z",
      },
      { daily: 1, active: 1 },
    );
    const res = await call(f);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("BOT_CHECK_FAILED");
    expect(f.steps).not.toContain("reserve");
    expect(f.store.issued).toHaveLength(1);
  });
});

describe("a request the handler can't read", () => {
  it.each([
    ["no body", null],
    ["a body that isn't JSON", "not json"],
    ["an empty token", JSON.stringify({ turnstileToken: "" })],
    ["no token", "{}"],
    [
      "an extra field (anything about the reviewer)",
      JSON.stringify({ turnstileToken: TOKEN, email: "a@example.com" }),
    ],
  ])("answers 400 for %s, before the bot check", async (_name, body) => {
    const f = setup();
    const res = await call(f, body);
    expect(res.statusCode).toBe(400);
    expect(RequestAccessError.parse(JSON.parse(res.body)).error.code).toBe("BAD_REQUEST");
    expect(f.steps).toEqual([]);
  });
});

describe("the caps", () => {
  it("refuses past the daily cap with the contact message, creating no Cognito user, profile or registry entry", async () => {
    const f = setup({ caps: { daily: 2, active: 10 } });
    expect((await call(f)).statusCode).toBe(200);
    expect((await call(f)).statusCode).toBe(200);
    f.steps.length = 0;
    const res = await call(f);
    expect(res.statusCode).toBe(429);
    const error = RequestAccessError.parse(JSON.parse(res.body)).error;
    expect(error).toEqual({ code: "CAP_REACHED", message: ACCESS_CAP_MESSAGE });
    expect(error.message).toContain("contact Nick");
    expect(f.steps).toEqual(["verify", "reserve"]);
    expect(f.store.issued).toHaveLength(2);
    expect(f.store.patients).toHaveLength(2);
    expect(f.users.size).toBe(2);
  });

  it("refuses past the active cap the same way", async () => {
    const f = setup({ caps: { daily: 10, active: 1 } });
    expect((await call(f)).statusCode).toBe(200);
    f.steps.length = 0;
    const res = await call(f);
    expect(res.statusCode).toBe(429);
    expect(RequestAccessError.parse(JSON.parse(res.body)).error.code).toBe("CAP_REACHED");
    expect(f.steps).toEqual(["verify", "reserve"]);
    expect(f.store.issued).toHaveLength(1);
    expect(f.users.size).toBe(1);
  });

  it("says try again, creating nothing, when the reservation only conflicted", async () => {
    const f = setup({ store: { reserve: () => Promise.resolve({ ok: false, reason: "conflict" }) } });
    const res = await call(f);
    expect(res.statusCode).toBe(503);
    expect(RequestAccessError.parse(JSON.parse(res.body)).error.code).toBe("TRY_AGAIN");
    expect(f.steps).toEqual(["verify", "reserve"]);
    expect(f.users.size).toBe(0);
  });
});

describe("a failure after the reservation", () => {
  it.each([
    ["creating the user", { createUser: () => Promise.reject(new Error("boom")) }],
    ["setting the password", { setPermanentPassword: () => Promise.reject(new Error("boom")) }],
    ["reading the sub", { getSub: () => Promise.reject(new Error("boom")) }],
  ])("answers try again and deletes the user once when %s fails", async (_name, admin) => {
    const f = setup({ admin });
    const res = await call(f);
    expect(res.statusCode).toBe(503);
    expect(RequestAccessError.parse(JSON.parse(res.body)).error.code).toBe("TRY_AGAIN");
    expect(f.steps.filter((s) => s.startsWith("deleteUser"))).toEqual(["deleteUser:user-aaaaaaaa"]);
    // The reservation stays, so the day's count stays used (A-3).
    expect(f.store.issued).toHaveLength(1);
    expect(f.store.dailyCount("2026-10-20")).toBe(1);
    expect(f.store.patients).toHaveLength(0);
  });

  it("answers try again and deletes the user when writing the profile fails", async () => {
    const f = setup({ store: { commit: () => Promise.reject(new Error("boom")) } });
    const res = await call(f);
    expect(res.statusCode).toBe(503);
    expect(f.steps.filter((s) => s.startsWith("deleteUser"))).toEqual(["deleteUser:user-aaaaaaaa"]);
  });

  it("still answers try again when the one delete attempt fails too", async () => {
    const f = setup({
      admin: {
        getSub: () => Promise.reject(new Error("boom")),
        deleteUser: () => Promise.reject(new Error("delete failed")),
      },
    });
    expect((await call(f)).statusCode).toBe(503);
  });

  it("logs the failure's name, never the password or the token", async () => {
    let password = "";
    const f = setup({
      admin: {
        setPermanentPassword: (_username, value) => {
          password = value;
          return Promise.resolve();
        },
        getSub: () => Promise.reject(new Error("boom")),
      },
    });
    await call(f);
    const text = JSON.stringify(f.logs);
    expect(f.logs.some((l) => l.level === "error")).toBe(true);
    expect(password).not.toBe("");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(password);
  });
});

describe("a random username clash", () => {
  /** An admin whose first `clashes` createUser calls find the username taken. */
  function clashing(clashes: number) {
    const tried: string[] = [];
    const admin: Partial<CognitoAdmin> = {
      createUser: (user) => {
        tried.push(user.username);
        return Promise.resolve(tried.length > clashes);
      },
      setPermanentPassword: () => Promise.resolve(),
    };
    return { tried, admin };
  }

  it("retries once with a new handle, and records the final username on the registry entry", async () => {
    const { tried, admin } = clashing(1);
    const f = setup({ admin });
    const res = await call(f);
    expect(res.statusCode).toBe(200);
    const body = RequestAccessResponse.parse(JSON.parse(res.body));
    expect(tried).toHaveLength(2);
    expect(tried[0]).toBe("user-aaaaaaaa");
    expect(tried[1]).not.toBe(tried[0]);
    expect(body.username).toBe(tried[1]);
    expect(f.store.issued[0]?.username).toBe(body.username);
  });

  it.each([
    ["setting the password", { setPermanentPassword: () => Promise.reject(new Error("boom")) }],
    ["reading the sub", { getSub: () => Promise.reject(new Error("boom")) }],
  ])(
    "deletes only the user it created, never the clashed one, when %s fails after a clash",
    async (_name, later) => {
      const { tried, admin } = clashing(1);
      const f = setup({ admin: { ...admin, ...later } });
      const res = await call(f);
      expect(res.statusCode).toBe(503);
      expect(tried).toHaveLength(2);
      expect(f.steps.filter((s) => s.startsWith("deleteUser"))).toEqual([`deleteUser:${tried[1]}`]);
      expect(f.steps).not.toContain(`deleteUser:${tried[0]}`);
    },
  );

  it("answers try again after a second clash, without deleting either user (neither is ours)", async () => {
    const { tried, admin } = clashing(2);
    const f = setup({ admin });
    const res = await call(f);
    expect(res.statusCode).toBe(503);
    expect(tried).toHaveLength(2);
    expect(f.steps.filter((s) => s.startsWith("deleteUser"))).toEqual([]);
    expect(f.store.patients).toHaveLength(0);
  });
});

describe("what is logged (A-7)", () => {
  it("carries the request ID, the outcome and timings, and nothing else", async () => {
    const f = setup();
    await call(f);
    expect(f.logs).toEqual([{ msg: "request-access", requestId: "req-1", outcome: "issued", totalMs: 12 }]);
  });

  it.each([
    ["bot_check_failed", { verdict: { ok: false, reason: "rejected" } as BotCheckResult }],
    ["bot_check_unavailable", { verdict: { ok: false, reason: "unavailable" } as BotCheckResult }],
    ["try_again", { store: { reserve: () => Promise.resolve({ ok: false, reason: "conflict" } as const) } }],
    ["capped", { caps: { daily: 1, active: 0 } }],
  ])("names the outcome %s", async (outcome, options) => {
    const f = setup(options);
    await call(f);
    expect(f.logs.at(-1)).toMatchObject({ msg: "request-access", outcome });
  });

  it("names bad_request and error", async () => {
    const bad = setup();
    await call(bad, "x");
    expect(bad.logs.at(-1)).toMatchObject({ outcome: "bad_request" });
    const err = setup({ admin: { getSub: () => Promise.reject(new Error("boom")) } });
    await call(err);
    expect(err.logs.at(-1)).toMatchObject({ outcome: "error" });
  });

  it("never holds the token, the username or the password", async () => {
    const f = setup();
    const body = RequestAccessResponse.parse(JSON.parse((await call(f)).body));
    const text = JSON.stringify(f.logs);
    for (const secret of [TOKEN, body.username, body.password, body.firstName, body.lastName]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("the proxy adapter", () => {
  it("reads the body and the API Gateway request ID, and never an identity field", async () => {
    const f = setup();
    const handler = requestAccessProxyHandler(f.deps);
    const res = await handler({ body: BODY, requestContext: { requestId: "gw-1" } });
    expect(res.statusCode).toBe(200);
    expect(f.logs[0]).toMatchObject({ requestId: "gw-1" });
  });

  it("reads a base64 body", async () => {
    const f = setup();
    const res = await requestAccessProxyHandler(f.deps)({
      body: Buffer.from(BODY).toString("base64"),
      isBase64Encoded: true,
      requestContext: { requestId: "gw-2" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("the failure table", () => {
  it("pairs each code with its status and its message, from the contract's one table", () => {
    expect(Object.entries(ACCESS_ERRORS).map(([code, f]) => [code, f.status])).toEqual([
      ["BAD_REQUEST", 400],
      ["BOT_CHECK_FAILED", 403],
      ["CAP_REACHED", 429],
      ["TRY_AGAIN", 503],
    ]);
  });

  it.each([
    ["BAD_REQUEST", "x"],
    ["BOT_CHECK_FAILED", BODY],
  ] as const)("answers %s with the table's status and message", async (code, body) => {
    const f = setup({ verdict: { ok: false, reason: "rejected" } });
    const res = await call(f, body);
    expect(res.statusCode).toBe(ACCESS_ERRORS[code].status);
    expect(JSON.parse(res.body)).toEqual({ error: { code, message: ACCESS_ERRORS[code].message } });
  });
});
