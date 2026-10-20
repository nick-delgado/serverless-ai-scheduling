import { Patient } from "@sched/contracts";
import { buildClinicFixture } from "@sched/tools/fixtures";
import { describe, expect, it } from "vitest";

import {
  BIRTH_DATES,
  FIRST_NAMES,
  LAST_NAMES,
  newIdentity,
  newPassword,
  newUsername,
  type RandomInt,
  USERNAME_PREFIX,
} from "../src/lib/access-identity";
import { passwordProblems } from "../src/lib/cognito-admin";

/** A deterministic generator that returns the next of `values`, each clamped into range. */
const scripted = (...values: number[]): RandomInt => {
  let i = 0;
  return (max) => (values[i++ % values.length] as number) % max;
};
/** A small linear congruential generator, so the property checks see many different draws. */
const lcg = (seed: number): RandomInt => {
  let state = seed;
  return (max) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % max;
  };
};

describe("newUsername", () => {
  it("is user- and 8 lowercase letters or digits", () => {
    expect(newUsername(scripted(0))).toBe("user-aaaaaaaa");
    expect(newUsername(scripted(35))).toBe("user-99999999");
    expect(newUsername(lcg(1))).toMatch(/^user-[a-z0-9]{8}$/);
  });

  it("starts with the prefix the expiry job's guard keys on", () => {
    expect(USERNAME_PREFIX).toBe("user-");
  });

  it("matches no fixture patient's username", () => {
    const fixtureUsernames = buildClinicFixture().patients.map((p) =>
      `${p.firstName}.${p.lastName}`.toLowerCase(),
    );
    for (const name of fixtureUsernames) expect(name.startsWith(USERNAME_PREFIX)).toBe(false);
  });
});

describe("newIdentity", () => {
  it("draws the names and birth date from the fixed lists", () => {
    expect(newIdentity(scripted(0))).toEqual({
      firstName: FIRST_NAMES[0],
      lastName: LAST_NAMES[0],
      dateOfBirth: BIRTH_DATES[0],
    });
    expect(newIdentity(scripted(1, 2, 3))).toEqual({
      firstName: FIRST_NAMES[1],
      lastName: LAST_NAMES[2],
      dateOfBirth: BIRTH_DATES[3],
    });
  });

  it("offers at least 10 first names and 10 surnames, none a fixture patient's surname", () => {
    expect(FIRST_NAMES.length).toBeGreaterThanOrEqual(10);
    expect(LAST_NAMES.length).toBeGreaterThanOrEqual(10);
    const fixtureLastNames = buildClinicFixture().patients.map((p) => p.lastName.toLowerCase());
    expect(fixtureLastNames.length).toBeGreaterThan(0);
    for (const last of LAST_NAMES) expect(fixtureLastNames).not.toContain(last.toLowerCase());
  });

  it("offers no fixture first name either, so no temporary patient can pass for a fixture one", () => {
    const fixtureFirst = buildClinicFixture().patients.map((p) => p.firstName.toLowerCase());
    for (const first of FIRST_NAMES) expect(fixtureFirst).not.toContain(first.toLowerCase());
  });

  it("produces a profile the Patient contract accepts", () => {
    for (let i = 0; i < FIRST_NAMES.length; i++) {
      const parsed = Patient.safeParse({
        patientId: "3f6c1a2e-8b4d-4c1a-9f2e-6d5b7a8c9e01",
        ...newIdentity(scripted(i)),
        createdAt: "2026-10-20T12:00:00Z",
      });
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });
});

describe("newPassword", () => {
  it("meets the User Pool's policy every time, at 16 characters", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const password = newPassword(lcg(seed));
      expect(password).toHaveLength(16);
      expect(passwordProblems(password)).toEqual([]);
    }
  });

  it("leaves out the characters that read alike (0, O, 1, l, I)", () => {
    for (let seed = 1; seed <= 300; seed++) expect(newPassword(lcg(seed))).not.toMatch(/[0O1lI]/);
  });

  it("shuffles the required characters instead of leaving them in front", () => {
    // With every draw 0 the picks are "aA2" then thirteen "a", and each swap trades with position 0.
    // Without the shuffle the password would be "aA2aaaaaaaaaaaaa".
    expect(newPassword(scripted(0))).toBe("A2aaaaaaaaaaaaaa");
  });

  it("differs between draws", () => {
    expect(newPassword(lcg(1))).not.toBe(newPassword(lcg(2)));
  });
});
