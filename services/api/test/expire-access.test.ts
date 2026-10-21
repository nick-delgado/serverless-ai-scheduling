/**
 * The expiry job's rules (`lib/expire-access.ts`; #357 part 2, owner decisions r1/Q-3 (a), r1/A-4, r2/A-15): which
 * entries are due, the order of the steps, what each failure leaves behind, what the log carries. The store is the
 * in-memory twin, the admin and the data deleter record their calls. The real tables are in
 * `expire-access.local.test.ts`.
 */
import type { LogEntry } from "../src/lib/log";
import { FrozenClock } from "@sched/tools";
import { describe, expect, it } from "vitest";

import { createInMemoryAccessStore, type InMemoryAccessStore } from "../src/lib/access-store";
import type { AccountData } from "../src/lib/account-data";
import { expireAccess, expiryHandler, type ExpireDeps } from "../src/lib/expire-access";
import { numberedReservation } from "./dynamo-fakes";

const NOW = "2026-10-21T15:00:00Z";
const CAPS = { daily: 100, active: 100 };
const sub = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

/** n-th account: reserved, and committed (with a sub) unless `withSub` is false. `at` overrides its expiry. */
async function issue(store: InMemoryAccessStore, n: number, opts: { at?: string; withSub?: boolean } = {}) {
  const r = { ...numberedReservation(n), accessExpiresAt: opts.at ?? "2026-10-21T14:00:00Z" };
  await store.reserve(r, CAPS);
  if (opts.withSub !== false) {
    await store.commit(r, {
      patientId: sub(n),
      firstName: "Noor",
      lastName: "Vance",
      dateOfBirth: "1990-08-09",
      createdAt: "2026-10-20T14:00:00Z",
    });
  }
  return r;
}

interface Fixture {
  deps: ExpireDeps;
  store: InMemoryAccessStore;
  calls: string[];
  logs: LogEntry[];
  /** Usernames that exist in the pool, with their sub. */
  users: Map<string, string>;
}

function fixture(
  opts: {
    admin?: Partial<ExpireDeps["admin"]>;
    data?: AccountData["deleteAccount"];
    release?: InMemoryAccessStore["release"];
  } = {},
): Fixture {
  const store = createInMemoryAccessStore();
  const calls: string[] = [];
  const logs: LogEntry[] = [];
  const users = new Map<string, string>();
  const release = store.release.bind(store);
  const deps: ExpireDeps = {
    store: {
      listExpired: (now) => store.listExpired(now),
      release: (entry) => {
        calls.push(`release ${entry.requestId.slice(-2)}`);
        return (opts.release ?? release)(entry);
      },
    },
    admin: {
      findSub: (username) => {
        calls.push(`findSub ${username}`);
        return Promise.resolve(users.get(username));
      },
      globalSignOut: (username) => {
        calls.push(`signOut ${username}`);
        return Promise.resolve();
      },
      deleteUser: (username) => {
        calls.push(`delete ${username}`);
        users.delete(username);
        return Promise.resolve();
      },
      ...opts.admin,
    },
    data: {
      deleteAccount: (patientId) => {
        calls.push(`data ${patientId.slice(-2)}`);
        return opts.data ? opts.data(patientId) : Promise.resolve({ items: 3, slotsFreed: 1 });
      },
    },
    clock: new FrozenClock(NOW),
    log: (entry) => logs.push(entry),
  };
  return { deps, store, calls, logs, users };
}

/** The pool holds the user an entry names, under the entry's own sub. */
const inPool = (f: Fixture, n: number) => f.users.set(numberedReservation(n).username, sub(n));

describe("expireAccess", () => {
  it("signs the user out, deletes it, deletes its data, then releases the entry, in that order", async () => {
    const f = fixture();
    await issue(f.store, 1);
    inPool(f, 1);

    const summary = await expireAccess(f.deps);

    expect(f.calls).toEqual([
      "findSub user-00000001",
      "signOut user-00000001",
      "delete user-00000001",
      "data 01",
      "release 01",
    ]);
    expect(summary).toEqual({ asOf: NOW, due: 1, expired: 1, skipped: 0, failed: 0 });
    expect(f.store.issued).toEqual([]);
    expect(f.store.activeCount()).toBe(0);
  });

  it("treats an entry at or before now as due, and one a second later as not due", async () => {
    const f = fixture();
    await issue(f.store, 1, { at: NOW });
    await issue(f.store, 2, { at: "2026-10-21T15:00:01Z" });
    inPool(f, 1);
    inPool(f, 2);

    const summary = await expireAccess(f.deps);

    expect(summary).toMatchObject({ due: 1, expired: 1 });
    expect(f.store.issued.map((e) => e.username)).toEqual(["user-00000002"]);
    expect(f.calls).not.toContain("delete user-00000002");
  });

  it("goes through the due entries oldest first", async () => {
    const f = fixture();
    await issue(f.store, 2, { at: "2026-10-21T13:00:00Z" });
    await issue(f.store, 1, { at: "2026-10-21T12:00:00Z" });
    inPool(f, 1);
    inPool(f, 2);
    await expireAccess(f.deps);
    expect(f.calls.filter((c) => c.startsWith("delete "))).toEqual([
      "delete user-00000001",
      "delete user-00000002",
    ]);
  });

  it("runs as of an operator's time when one is given, expiring accounts that aren't due yet", async () => {
    const f = fixture();
    await issue(f.store, 1, { at: "2026-10-22T09:00:00Z" });
    inPool(f, 1);
    expect(await expireAccess(f.deps)).toMatchObject({ due: 0 });
    const summary = await expireAccess(f.deps, new Date("2026-10-22T09:00:00Z"));
    expect(summary).toEqual({ asOf: "2026-10-22T09:00:00Z", due: 1, expired: 1, skipped: 0, failed: 0 });
  });

  it("skips an entry whose username has no user- prefix: nothing deleted, the entry stays, logged by request ID", async () => {
    const f = fixture();
    const r = await issue(f.store, 1);
    // A fixture patient's username in a registry entry (a corrupted or hand-written one).
    const entry = f.store.issued[0];
    if (!entry) throw new Error("no entry");
    entry.username = "maria.santos";

    const summary = await expireAccess(f.deps);

    expect(f.calls).toEqual([]);
    expect(summary).toEqual({ asOf: NOW, due: 1, expired: 0, skipped: 1, failed: 0 });
    expect(f.store.issued).toHaveLength(1);
    expect(f.logs).toContainEqual({
      msg: "access-expiry skipped an entry without the user- prefix",
      level: "warn",
      requestId: r.requestId,
    });
  });

  it("accepts the prefix exactly: user- followed by the handle", async () => {
    const f = fixture();
    await issue(f.store, 1);
    inPool(f, 1);
    expect((await expireAccess(f.deps)).expired).toBe(1);
    const g = fixture();
    await issue(g.store, 2);
    const entry = g.store.issued[0];
    if (!entry) throw new Error("no entry");
    entry.username = "xuser-00000002";
    expect((await expireAccess(g.deps)).skipped).toBe(1);
  });

  it("deletes no user for an entry with no sub, and releases it", async () => {
    const f = fixture();
    await issue(f.store, 1, { withSub: false });
    inPool(f, 1);

    const summary = await expireAccess(f.deps);

    expect(f.calls).toEqual(["release 01"]);
    expect(f.users.size).toBe(1);
    expect(summary).toMatchObject({ expired: 1, failed: 0 });
    expect(f.logs).toContainEqual(
      expect.objectContaining({ msg: "access-expiry entry", outcome: "released_unissued" }),
    );
  });

  it("counts an entry with no sub that another run already released as released once", async () => {
    const f = fixture({ release: () => Promise.resolve({ ok: false, reason: "gone" }) });
    await issue(f.store, 1, { withSub: false });
    expect(await expireAccess(f.deps)).toMatchObject({ expired: 1, failed: 0 });
    expect(f.logs).toContainEqual(
      expect.objectContaining({ msg: "access-expiry entry", outcome: "already_released" }),
    );
  });

  it("leaves a user alone whose sub isn't the entry's, but still deletes the entry's data and releases it", async () => {
    const f = fixture();
    await issue(f.store, 1);
    f.users.set("user-00000001", sub(99));

    const summary = await expireAccess(f.deps);

    expect(f.calls).toEqual(["findSub user-00000001", "data 01", "release 01"]);
    expect(f.users.get("user-00000001")).toBe(sub(99));
    expect(summary).toMatchObject({ expired: 1, failed: 0 });
    expect(f.logs).toContainEqual(
      expect.objectContaining({ msg: "access-expiry left a user with another sub alone", level: "warn" }),
    );
  });

  it("goes on to the data when the user is already gone, calling neither sign-out nor delete", async () => {
    const f = fixture();
    await issue(f.store, 1);
    await expireAccess(f.deps);
    expect(f.calls).toEqual(["findSub user-00000001", "data 01", "release 01"]);
    expect(f.store.issued).toEqual([]);
  });

  it("counts an entry already released by another run as expired once, calling release again harmlessly", async () => {
    const f = fixture({ release: () => Promise.resolve({ ok: false, reason: "gone" }) });
    await issue(f.store, 1);
    inPool(f, 1);
    const summary = await expireAccess(f.deps);
    expect(summary).toMatchObject({ expired: 1, failed: 0 });
    expect(f.logs).toContainEqual(
      expect.objectContaining({ msg: "access-expiry entry", outcome: "already_released" }),
    );
  });

  describe("a failure leaves the entry for the next run", () => {
    const boom = () => Promise.reject(new Error("throttled"));

    it.each([
      ["the user lookup", { findSub: boom }, []],
      ["the sign-out", { globalSignOut: boom }, ["findSub user-00000001"]],
      [
        "the user delete",
        {
          deleteUser: (u: string) => {
            void u;
            return boom();
          },
        },
        ["findSub user-00000001", "signOut user-00000001"],
      ],
    ])("when %s fails: no data is deleted and the entry stays", async (_name, admin, calls) => {
      const f = fixture({ admin });
      await issue(f.store, 1);
      inPool(f, 1);

      const summary = await expireAccess(f.deps);

      expect(f.calls).toEqual(calls);
      expect(summary).toMatchObject({ due: 1, expired: 0, failed: 1 });
      expect(f.store.issued).toHaveLength(1);
      expect(f.store.activeCount()).toBe(1);
    });

    it("when the data delete fails: the user is gone, the entry stays, and the next run finishes it", async () => {
      let fail = true;
      const f = fixture({
        data: () =>
          fail ? Promise.reject(new Error("throttled")) : Promise.resolve({ items: 1, slotsFreed: 0 }),
      });
      await issue(f.store, 1);
      inPool(f, 1);

      expect(await expireAccess(f.deps)).toMatchObject({ expired: 0, failed: 1 });
      expect(f.users.size).toBe(0);
      expect(f.store.issued).toHaveLength(1);

      fail = false;
      expect(await expireAccess(f.deps)).toMatchObject({ expired: 1, failed: 0 });
      expect(f.store.issued).toEqual([]);
    });

    it("when the release fails: everything before it is done and the entry stays, for the next run", async () => {
      let fail = true;
      const f = fixture({
        release: (e) => (fail ? Promise.reject(new Error("conflict")) : f.store.release(e)),
      });
      await issue(f.store, 1);
      inPool(f, 1);

      expect(await expireAccess(f.deps)).toMatchObject({ expired: 0, failed: 1 });
      expect(f.store.issued).toHaveLength(1);

      fail = false;
      expect(await expireAccess(f.deps)).toMatchObject({ expired: 1, failed: 0 });
      expect(f.store.issued).toEqual([]);
    });

    it("carries on with the other entries, and logs the failure by request ID and error name only", async () => {
      const f = fixture({
        data: (id) =>
          id === sub(1)
            ? Promise.reject(new TypeError("secret detail"))
            : Promise.resolve({ items: 1, slotsFreed: 0 }),
      });
      const first = await issue(f.store, 1, { at: "2026-10-21T10:00:00Z" });
      await issue(f.store, 2, { at: "2026-10-21T11:00:00Z" });
      inPool(f, 1);
      inPool(f, 2);

      const summary = await expireAccess(f.deps);

      expect(summary).toEqual({ asOf: NOW, due: 2, expired: 1, skipped: 0, failed: 1 });
      expect(f.store.issued.map((e) => e.username)).toEqual(["user-00000001"]);
      expect(f.logs).toContainEqual({
        msg: "access-expiry entry failed",
        level: "error",
        requestId: first.requestId,
        errorName: "TypeError",
      });
    });
  });

  it("logs request IDs, outcomes and counts only: no username, sub or name", async () => {
    const f = fixture();
    await issue(f.store, 1);
    inPool(f, 1);
    await expireAccess(f.deps);
    expect(f.logs).toEqual([
      { msg: "access-expiry data", requestId: numberedReservation(1).requestId, items: 3, slotsFreed: 1 },
      { msg: "access-expiry entry", requestId: numberedReservation(1).requestId, outcome: "expired" },
      { msg: "access-expiry", asOf: NOW, due: 1, expired: 1, skipped: 0, failed: 0 },
    ]);
    const text = JSON.stringify(f.logs);
    for (const hidden of ["user-00000001", sub(1), "Noor", "Vance"]) expect(text).not.toContain(hidden);
  });

  it("works without a logger", async () => {
    const f = fixture();
    await issue(f.store, 1);
    delete (f.deps as { log?: unknown }).log;
    await expect(expireAccess(f.deps)).resolves.toMatchObject({ due: 1 });
  });
});

describe("expiryHandler", () => {
  it("runs as of the clock for EventBridge's scheduled event, ignoring its other fields", async () => {
    const f = fixture();
    await issue(f.store, 1);
    inPool(f, 1);
    const summary = await expiryHandler(f.deps)({
      version: "0",
      "detail-type": "Scheduled Event",
      source: "aws.events",
      time: "2030-01-01T00:00:00Z",
      detail: {},
    });
    expect(summary).toMatchObject({ asOf: NOW, expired: 1 });
  });

  it("runs as of the event's asOf when it carries one", async () => {
    const f = fixture();
    await issue(f.store, 1, { at: "2099-01-01T00:00:00Z" });
    inPool(f, 1);
    const summary = await expiryHandler(f.deps)({ asOf: "9999-12-31T23:59:59Z" });
    expect(summary).toMatchObject({ asOf: "9999-12-31T23:59:59Z", due: 1, expired: 1 });
  });

  it.each([{ asOf: "not a date" }, { asOf: 12345 }, { asOf: null }, { asOf: "" }])(
    "fails before reading anything when asOf is %j",
    async (event) => {
      const f = fixture();
      await issue(f.store, 1);
      await expect(expiryHandler(f.deps)(event)).rejects.toThrow("asOf must be an ISO date-time string");
      expect(f.calls).toEqual([]);
    },
  );

  it.each([undefined, null, "a string", 5, {}])("takes %j as no asOf", async (event) => {
    const f = fixture();
    await expect(expiryHandler(f.deps)(event)).resolves.toMatchObject({ asOf: NOW, due: 0 });
  });

  it("throws after trying every entry when any failed, so the invocation shows as failed", async () => {
    let lookups = 0;
    const f = fixture({
      admin: {
        findSub: () => {
          lookups++;
          return Promise.reject(new Error("throttled"));
        },
      },
    });
    await issue(f.store, 1);
    await issue(f.store, 2);
    await expect(expiryHandler(f.deps)({})).rejects.toThrow("2 of 2 accounts failed to expire");
    expect(lookups).toBe(2);
  });
});
