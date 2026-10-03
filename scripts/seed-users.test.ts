import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { FIXTURE_PATIENT_IDS } from "@sched/tools/fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type CognitoAdmin,
  cognitoAdmin,
  type DemoUserSpec,
  idTokenSub,
  mappingPath,
  mergeMapping,
  passwordProblems,
  planDemoUsers,
  readMapping,
  seedUsers,
  type SeededUser,
  srpSignInSub,
  updateMappingFile,
  type UserMapping,
} from "./seed-users";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Drives the mocked `amazon-cognito-identity-js` sign-in: which callback `authenticateUser` calls. */
const srp = vi.hoisted(() => ({
  outcome: "success" as "success" | "newPasswordRequired",
  claims: {} as Record<string, unknown>,
}));

vi.mock("amazon-cognito-identity-js", () => ({
  AuthenticationDetails: class {
    constructor(readonly data: unknown) {}
  },
  CognitoUserPool: class {
    constructor(readonly data: unknown) {}
  },
  CognitoUser: class {
    authenticateUser(
      _details: unknown,
      callbacks: {
        onSuccess: (session: { getIdToken: () => { decodePayload: () => Record<string, unknown> } }) => void;
        newPasswordRequired: () => void;
      },
    ) {
      if (srp.outcome === "newPasswordRequired") callbacks.newPasswordRequired();
      else callbacks.onSuccess({ getIdToken: () => ({ decodePayload: () => srp.claims }) });
    }
  },
}));

// Synthetic test passwords: they meet the pool policy and are never used against AWS.
const GOOD = "Synthetic-Test-Pass-1";
const GOOD_2 = "Another-Synthetic-Pass-2";

describe("passwordProblems", () => {
  it("accepts a password that meets the User Pool policy", () => {
    expect(passwordProblems(GOOD)).toEqual([]);
  });

  it("enforces the 12-character minimum at its boundary", () => {
    expect(passwordProblems("Abcdefghij1")).toEqual(["is shorter than 12 characters"]); // 11
    expect(passwordProblems("Abcdefghijk1")).toEqual([]); // 12
  });

  it("matches the PasswordPolicy in infra/stacks/auth.yaml", () => {
    const template = readFileSync(join(repoRoot, "infra/stacks/auth.yaml"), "utf8");
    const setting = (key: string): string => {
      const m = new RegExp(`^\\s+${key}: (\\S+)`, "m").exec(template);
      if (!m?.[1]) throw new Error(`PasswordPolicy.${key} not found in auth.yaml`);
      return m[1];
    };
    const min = Number(setting("MinimumLength"));
    // A password with every character class, at exactly the template's minimum length and one short.
    const atLength = (n: number) => "Aa1!".padEnd(n, "x");
    expect(passwordProblems(atLength(min))).toEqual([]);
    expect(passwordProblems(atLength(min - 1))).not.toEqual([]);

    const classes: [key: string, without: string][] = [
      ["RequireLowercase", "ABCDEFGHIJKLMN1!"],
      ["RequireUppercase", "abcdefghijklmn1!"],
      ["RequireNumbers", "Abcdefghijklmn!!"],
      ["RequireSymbols", "Abcdefghijklmn11"],
    ];
    for (const [key, without] of classes) {
      expect({ key, rejected: passwordProblems(without).length > 0 }).toEqual({
        key,
        rejected: setting(key) === "true",
      });
    }
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
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^created pat-maria/);
    expect(lines.join("\n")).not.toContain(GOOD);
    expect(JSON.stringify(seeded)).not.toContain(GOOD); // the rows become the mapping file
  });

  it("is idempotent: an existing user keeps its sub and gets the .env password", async () => {
    const { admin, users } = fakeAdmin({ "maria.santos": "sub-existing" });
    const lines: string[] = [];
    const seeded = await seedUsers(admin, [MARIA], (l) => lines.push(l));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^exists +pat-maria/);
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

/** A Cognito client whose `send` records each command and answers with `reply(command)`. */
function fakeCognito(reply: (command: unknown) => unknown = () => ({})) {
  const sent: unknown[] = [];
  const client = {
    send(command: unknown) {
      sent.push(command);
      try {
        return Promise.resolve(reply(command));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
  return { sent, client: client as unknown as CognitoIdentityProviderClient };
}

describe("cognitoAdmin", () => {
  it("creates the user with no invitation message and the patient's names", async () => {
    const { sent, client } = fakeCognito();
    await expect(cognitoAdmin(client, "pool-a").createUser(MARIA)).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(AdminCreateUserCommand);
    expect((sent[0] as AdminCreateUserCommand).input).toEqual({
      UserPoolId: "pool-a",
      Username: "maria.santos",
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "given_name", Value: "Maria" },
        { Name: "family_name", Value: "Santos" },
      ],
    });
  });

  it("resolves false when the username already exists", async () => {
    const { client } = fakeCognito(() => {
      throw new UsernameExistsException({ message: "exists", $metadata: {} });
    });
    await expect(cognitoAdmin(client, "pool-a").createUser(MARIA)).resolves.toBe(false);
  });

  it("rethrows any other create error", async () => {
    const { client } = fakeCognito(() => {
      throw new Error("throttled");
    });
    await expect(cognitoAdmin(client, "pool-a").createUser(MARIA)).rejects.toThrow("throttled");
  });

  it("sets the password as permanent", async () => {
    const { sent, client } = fakeCognito();
    await cognitoAdmin(client, "pool-a").setPermanentPassword("maria.santos", GOOD);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(AdminSetUserPasswordCommand);
    expect((sent[0] as AdminSetUserPasswordCommand).input).toEqual({
      UserPoolId: "pool-a",
      Username: "maria.santos",
      Password: GOOD,
      Permanent: true,
    });
  });

  it("reads the sub attribute of the user", async () => {
    const { sent, client } = fakeCognito(() => ({
      UserAttributes: [
        { Name: "given_name", Value: "Maria" },
        { Name: "sub", Value: "sub-123" },
      ],
    }));
    await expect(cognitoAdmin(client, "pool-a").getSub("maria.santos")).resolves.toBe("sub-123");
    expect(sent[0]).toBeInstanceOf(AdminGetUserCommand);
    expect((sent[0] as AdminGetUserCommand).input).toEqual({
      UserPoolId: "pool-a",
      Username: "maria.santos",
    });
  });

  it("throws when the user has no sub attribute", async () => {
    const { client } = fakeCognito(() => ({ UserAttributes: [{ Name: "given_name", Value: "Maria" }] }));
    await expect(cognitoAdmin(client, "pool-a").getSub("maria.santos")).rejects.toThrow(
      "User maria.santos has no sub attribute",
    );
  });
});

describe("mapping file", () => {
  let dir: string;
  const target = { env: "dev", userPoolId: "pool-a" };
  const row = (alias: SeededUser["alias"], sub: string): SeededUser => ({
    alias,
    fixturePatientId: FIXTURE_PATIENT_IDS[alias],
    username: alias,
    sub,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seed-users-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lives at .seed/cognito-users.<env>.json in the repository root, a git-ignored directory", () => {
    expect(relative(repoRoot, mappingPath("dev"))).toBe(join(".seed", "cognito-users.dev.json"));
    const ignored = readFileSync(join(repoRoot, ".gitignore"), "utf8").split("\n");
    expect(ignored).toContain(".seed/");
  });

  it("reads a missing file as no previous mapping", () => {
    expect(readMapping(join(dir, "none.json"))).toBeUndefined();
  });

  it("writes the merged mapping, mode 600, and merges the next run into it", () => {
    const path = join(dir, ".seed", "cognito-users.dev.json");
    const first = updateMappingFile(
      path,
      target,
      [row("pat-walter", "w-1")],
      new Date("2026-10-02T12:00:00Z"),
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const second = updateMappingFile(
      path,
      target,
      [row("pat-maria", "m-1")],
      new Date("2026-10-02T13:00:00Z"),
    );
    const expected: UserMapping = {
      env: "dev",
      userPoolId: "pool-a",
      updatedAt: "2026-10-02T13:00:00.000Z",
      users: [row("pat-maria", "m-1"), row("pat-walter", "w-1")],
    };
    expect(second).toEqual(expected);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(expected);
  });

  it.each([
    ["is not JSON", "{ not json", /is not valid JSON/],
    ["is null", "null", /does not have the expected shape/],
    [
      "has a null row",
      JSON.stringify({ env: "dev", userPoolId: "p", updatedAt: "x", users: [null] }),
      /does not have the expected shape/,
    ],
    [
      "has the wrong shape",
      JSON.stringify({ env: "dev", users: "nope" }),
      /does not have the expected shape/,
    ],
    [
      "has a row with an unknown alias",
      JSON.stringify({
        env: "dev",
        userPoolId: "p",
        updatedAt: "x",
        users: [{ alias: "pat-nobody", fixturePatientId: "p-1", username: "nobody", sub: "s-1" }],
      }),
      /does not have the expected shape/,
    ],
  ])("stops, naming the file and leaving it unchanged, when it %s", (_, text, message) => {
    const path = join(dir, "cognito-users.dev.json");
    writeFileSync(path, text);
    expect(() => updateMappingFile(path, target, [row("pat-maria", "m-1")], new Date())).toThrow(message);
    expect(() => readMapping(path)).toThrow(path);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  const valid = { env: "dev", userPoolId: "p", updatedAt: "x", users: [row("pat-maria", "m-1")] };
  it.each([
    ...(["env", "userPoolId", "updatedAt", "users"] as const).map(
      (key) => [key, { ...valid, [key]: 42 }] as const,
    ),
    ...(["alias", "fixturePatientId", "username", "sub"] as const).map(
      (key) => [`users[0].${key}`, { ...valid, users: [{ ...valid.users[0], [key]: 42 }] }] as const,
    ),
  ])("rejects a mapping whose %s is not a string (or array)", (_, mapping) => {
    const path = join(dir, "cognito-users.dev.json");
    writeFileSync(path, JSON.stringify(mapping));
    expect(() => readMapping(path)).toThrow(/does not have the expected shape/);
  });

  it("accepts a well-formed mapping", () => {
    const path = join(dir, "cognito-users.dev.json");
    writeFileSync(path, JSON.stringify(valid));
    expect(readMapping(path)).toEqual(valid);
  });

  it.skipIf(process.getuid?.() === 0)(
    "rethrows a read error other than a missing file, naming the path",
    () => {
      const path = join(dir, "unreadable.json");
      writeFileSync(path, "{}");
      chmodSync(path, 0o000);
      expect(() => readMapping(path)).toThrow(`Cannot read the user mapping ${path}`);
    },
  );
});

describe("idTokenSub", () => {
  it("returns the sub of an ID token", () => {
    expect(idTokenSub({ token_use: "id", sub: "sub-1" }, "maria.santos")).toBe("sub-1");
  });

  it("rejects a token that is not an ID token", () => {
    expect(() => idTokenSub({ token_use: "access", sub: "sub-1" }, "maria.santos")).toThrow(
      "unexpected ID token claims for maria.santos",
    );
  });

  it("rejects an ID token without a string sub", () => {
    expect(() => idTokenSub({ token_use: "id", sub: 42 }, "maria.santos")).toThrow(
      "unexpected ID token claims for maria.santos",
    );
  });
});

describe("srpSignInSub", () => {
  const pool = { userPoolId: "pool-a", clientId: "client-a" };

  it("resolves with the ID token's sub", async () => {
    srp.outcome = "success";
    srp.claims = { token_use: "id", sub: "sub-1" };
    await expect(srpSignInSub(pool, "maria.santos", GOOD)).resolves.toBe("sub-1");
  });

  it("rejects on unexpected claims", async () => {
    srp.outcome = "success";
    srp.claims = { token_use: "access", sub: "sub-1" };
    await expect(srpSignInSub(pool, "maria.santos", GOOD)).rejects.toThrow("unexpected ID token claims");
  });

  it("rejects a user who still needs a new password", async () => {
    srp.outcome = "newPasswordRequired";
    await expect(srpSignInSub(pool, "maria.santos", GOOD)).rejects.toThrow(
      "maria.santos still needs a new password",
    );
  });
});
