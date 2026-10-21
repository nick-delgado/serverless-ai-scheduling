/**
 * The Cognito admin adapter and the password policy check, moved out of scripts/seed-users.ts so the seed script and
 * the request-access handler share one way to create a patient (#357). Moved with their tests.
 */
import { readFileSync } from "node:fs";

import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  type CognitoIdentityProviderClient,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it } from "vitest";

import { cognitoAdmin, passwordProblems, type NewUser } from "../src/lib/cognito-admin";

// Synthetic test password: it meets the pool policy and is never used against AWS.
const GOOD = "Synthetic-Test-Pass-1";
const MARIA: NewUser = { username: "maria.santos", givenName: "Maria", familyName: "Santos" };

describe("passwordProblems", () => {
  it("accepts a password that meets the User Pool policy", () => {
    expect(passwordProblems(GOOD)).toEqual([]);
  });

  it("enforces the 12-character minimum at its boundary", () => {
    expect(passwordProblems("Abcdefghij1")).toEqual(["is shorter than 12 characters"]); // 11
    expect(passwordProblems("Abcdefghijk1")).toEqual([]); // 12
  });

  it("matches the PasswordPolicy in infra/stacks/auth.yaml", () => {
    const template = readFileSync(new URL("../../../infra/stacks/auth.yaml", import.meta.url), "utf8");
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
      /^User maria\.santos has no sub attribute$/,
    );
  });

  it("deletes the user", async () => {
    const { sent, client } = fakeCognito();
    await cognitoAdmin(client, "pool-a").deleteUser("user-x7k2m9qa");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(AdminDeleteUserCommand);
    expect((sent[0] as AdminDeleteUserCommand).input).toEqual({
      UserPoolId: "pool-a",
      Username: "user-x7k2m9qa",
    });
  });

  it("counts a user that is already gone as deleted", async () => {
    const { client } = fakeCognito(() => {
      throw new UserNotFoundException({ message: "gone", $metadata: {} });
    });
    await expect(cognitoAdmin(client, "pool-a").deleteUser("user-x7k2m9qa")).resolves.toBeUndefined();
  });

  it("rethrows any other delete error", async () => {
    const { client } = fakeCognito(() => {
      throw new Error("throttled");
    });
    await expect(cognitoAdmin(client, "pool-a").deleteUser("user-x7k2m9qa")).rejects.toThrow("throttled");
  });

  it("finds the sub of a user, and undefined when there is no such user", async () => {
    const found = fakeCognito(() => ({ UserAttributes: [{ Name: "sub", Value: "sub-123" }] }));
    await expect(cognitoAdmin(found.client, "pool-a").findSub("user-aaaaaaaa")).resolves.toBe("sub-123");
    expect((found.sent[0] as AdminGetUserCommand).input).toEqual({
      UserPoolId: "pool-a",
      Username: "user-aaaaaaaa",
    });

    const missing = fakeCognito(() => {
      throw new UserNotFoundException({ message: "no user", $metadata: {} });
    });
    await expect(cognitoAdmin(missing.client, "pool-a").findSub("user-aaaaaaaa")).resolves.toBeUndefined();
  });

  it("rethrows any other error from findSub", async () => {
    const { client } = fakeCognito(() => {
      throw new Error("throttled");
    });
    await expect(cognitoAdmin(client, "pool-a").findSub("user-aaaaaaaa")).rejects.toThrow("throttled");
  });

  it("signs the user out everywhere, and counts a missing user as signed out", async () => {
    const { sent, client } = fakeCognito();
    await cognitoAdmin(client, "pool-a").globalSignOut("user-aaaaaaaa");
    expect(sent[0]).toBeInstanceOf(AdminUserGlobalSignOutCommand);
    expect((sent[0] as AdminUserGlobalSignOutCommand).input).toEqual({
      UserPoolId: "pool-a",
      Username: "user-aaaaaaaa",
    });

    const missing = fakeCognito(() => {
      throw new UserNotFoundException({ message: "no user", $metadata: {} });
    });
    await expect(
      cognitoAdmin(missing.client, "pool-a").globalSignOut("user-aaaaaaaa"),
    ).resolves.toBeUndefined();
  });

  it("rethrows any other error from globalSignOut", async () => {
    const { client } = fakeCognito(() => {
      throw new Error("throttled");
    });
    await expect(cognitoAdmin(client, "pool-a").globalSignOut("user-aaaaaaaa")).rejects.toThrow("throttled");
  });
});
