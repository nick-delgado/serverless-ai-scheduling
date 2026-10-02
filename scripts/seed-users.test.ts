import { FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import {
  type CognitoAdmin,
  type DemoUserSpec,
  mergeMapping,
  passwordProblems,
  planDemoUsers,
  seedUsers,
  type SeededUser,
} from "./seed-users";

// Synthetic test passwords: they meet the pool policy and are never used against AWS.
const GOOD = "Synthetic-Test-Pass-1";
const GOOD_2 = "Another-Synthetic-Pass-2";

describe("passwordProblems", () => {
  it("accepts a password that meets the User Pool policy", () => {
    expect(passwordProblems(GOOD)).toEqual([]);
  });

  it("names every rule a weak password breaks", () => {
    expect(passwordProblems("short")).toEqual([
      "is shorter than 12 characters",
      "has no uppercase letter",
      "has no number",
    ]);
    expect(passwordProblems("ALLUPPERCASE123")).toEqual(["has no lowercase letter"]);
  });
});

describe("planDemoUsers", () => {
  it("seeds only the fixture patients whose password is set, as <first>.<last>", () => {
    const specs = planDemoUsers({ DEMO_PASSWORD_MARIA: GOOD, DEMO_PASSWORD_WALTER: GOOD_2, HOME: "/x" });
    expect(specs).toEqual([
      {
        alias: "pat-maria",
        fixturePatientId: FIXTURE_PATIENT_IDS["pat-maria"],
        username: "maria.santos",
        givenName: "Maria",
        familyName: "Santos",
        password: GOOD,
      },
      {
        alias: "pat-walter",
        fixturePatientId: FIXTURE_PATIENT_IDS["pat-walter"],
        username: "walter.haines",
        givenName: "Walter",
        familyName: "Haines",
        password: GOOD_2,
      },
    ]);
  });

  it("covers every fixture patient", () => {
    const vars = Object.fromEntries(
      Object.keys(FIXTURE_PATIENT_IDS).map((a) => [`DEMO_PASSWORD_${a.slice(4).toUpperCase()}`, GOOD]),
    );
    expect(planDemoUsers(vars).map((s) => s.alias)).toEqual(Object.keys(FIXTURE_PATIENT_IDS));
  });

  it("rejects a weak password by variable name, without echoing the value", () => {
    const weak = "weakpassword";
    const run = () => planDemoUsers({ DEMO_PASSWORD_MARIA: weak });
    expect(run).toThrow(/DEMO_PASSWORD_MARIA has no uppercase letter, has no number/);
    expect(run).not.toThrow(new RegExp(weak));
  });

  it("rejects a password variable that names no fixture patient (a typo)", () => {
    expect(() => planDemoUsers({ DEMO_PASSWORD_MARIA: GOOD, DEMO_PASSWORD_MARIAH: GOOD })).toThrow(
      /DEMO_PASSWORD_MARIAH names no fixture patient/,
    );
  });

  it("refuses to run with no users configured", () => {
    expect(() => planDemoUsers({ DEMO_PASSWORD_MARIA: "" })).toThrow(/No demo users configured/);
  });
});

/** In-memory User Pool: usernames → { sub, password }. */
function fakeAdmin(existing: Record<string, string> = {}) {
  const users = new Map<string, { sub: string; password?: string; permanent: boolean }>(
    Object.entries(existing).map(([u, sub]) => [u, { sub, permanent: true }]),
  );
  let next = 0;
  const admin: CognitoAdmin = {
    createUser: (spec) => {
      if (users.has(spec.username)) return Promise.resolve(false);
      users.set(spec.username, { sub: `sub-${++next}`, permanent: false });
      return Promise.resolve(true);
    },
    getSub: (username) => {
      const u = users.get(username);
      return u ? Promise.resolve(u.sub) : Promise.reject(new Error(`no user ${username}`));
    },
    setPermanentPassword: (username, password) => {
      const u = users.get(username);
      if (!u) return Promise.reject(new Error(`no user ${username}`));
      u.password = password;
      u.permanent = true;
      return Promise.resolve();
    },
  };
  return { admin, users };
}

const [MARIA] = planDemoUsers({ DEMO_PASSWORD_MARIA: GOOD }) as [DemoUserSpec];

describe("seedUsers", () => {
  it("creates a new user with a permanent password and returns its sub", async () => {
    const { admin, users } = fakeAdmin();
    const lines: string[] = [];
    const seeded = await seedUsers(admin, [MARIA], (l) => lines.push(l));

    expect(seeded).toEqual([
      {
        alias: "pat-maria",
        fixturePatientId: FIXTURE_PATIENT_IDS["pat-maria"],
        username: "maria.santos",
        sub: "sub-1",
      },
    ]);
    expect(users.get("maria.santos")).toEqual({ sub: "sub-1", password: GOOD, permanent: true });
    expect(lines.join("\n")).not.toContain(GOOD);
    expect(JSON.stringify(seeded)).not.toContain(GOOD); // the rows become the mapping file
  });

  it("is idempotent: an existing user keeps its sub and gets the .env password", async () => {
    const { admin, users } = fakeAdmin({ "maria.santos": "sub-existing" });
    const seeded = await seedUsers(admin, [MARIA]);

    expect(seeded[0]?.sub).toBe("sub-existing");
    expect(users.size).toBe(1);
    expect(users.get("maria.santos")?.password).toBe(GOOD);
  });
});

describe("mergeMapping", () => {
  const row = (alias: SeededUser["alias"], sub: string): SeededUser => ({
    alias,
    fixturePatientId: FIXTURE_PATIENT_IDS[alias],
    username: alias,
    sub,
  });
  const now = new Date("2026-10-02T12:00:00Z");

  it("keeps earlier rows for the same pool and replaces re-seeded ones", () => {
    const previous = {
      env: "dev",
      userPoolId: "pool-a",
      updatedAt: "x",
      users: [row("pat-walter", "w-1"), row("pat-maria", "m-old")],
    };
    const merged = mergeMapping(
      previous,
      { env: "dev", userPoolId: "pool-a" },
      [row("pat-maria", "m-1")],
      now,
    );
    expect(merged).toEqual({
      env: "dev",
      userPoolId: "pool-a",
      updatedAt: "2026-10-02T12:00:00.000Z",
      users: [row("pat-maria", "m-1"), row("pat-walter", "w-1")],
    });
  });

  it("drops rows from a different (recreated) pool, whose subs no longer exist", () => {
    const previous = {
      env: "pr1",
      userPoolId: "pool-old",
      updatedAt: "x",
      users: [row("pat-walter", "w-1")],
    };
    const merged = mergeMapping(
      previous,
      { env: "pr1", userPoolId: "pool-new" },
      [row("pat-maria", "m-1")],
      now,
    );
    expect(merged.users).toEqual([row("pat-maria", "m-1")]);
  });
});
