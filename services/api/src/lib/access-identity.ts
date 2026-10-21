/**
 * What a temporary reviewer patient is made of (#357, owner decisions r1/Q-6 (a) and its `user-` note): a username,
 * a password, and a synthetic name and date of birth. Everything is drawn at random, with no input from the
 * reviewer, so nothing here identifies them (CLAUDE.md rule 6). Randomness is injected: production uses
 * `crypto.randomInt`, tests pass a deterministic function.
 */
import { randomInt } from "node:crypto";

import { ACCESS_USERNAME_PREFIX } from "@sched/contracts";

/** A random integer in `[0, maxExclusive)`. */
export type RandomInt = (maxExclusive: number) => number;

export const cryptoRandomInt: RandomInt = (maxExclusive) => randomInt(maxExclusive);

const HANDLE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const HANDLE_LENGTH = 8;

/**
 * Fictional first names and surnames. None of the surnames is a fixture patient's (Santos, Haines, Rahman, Park,
 * Marquez, Whitaker), which a test checks against `@sched/tools/fixtures`.
 */
export const FIRST_NAMES = [
  "Noor",
  "Elias",
  "Imani",
  "Tomas",
  "Priya",
  "Gideon",
  "Leilani",
  "Mateo",
  "Anika",
  "Rowan",
  "Saoirse",
  "Dario",
] as const;

export const LAST_NAMES = [
  "Vance",
  "Okafor",
  "Lindqvist",
  "Moreau",
  "Tanaka",
  "Brennan",
  "Castellano",
  "Adeyemi",
  "Novak",
  "Fairweather",
  "Halloran",
  "Quintero",
] as const;

/** Synthetic dates of birth (adults), clinic-local `YYYY-MM-DD`. */
export const BIRTH_DATES = [
  "1958-03-14",
  "1964-09-02",
  "1971-11-23",
  "1979-05-30",
  "1985-01-17",
  "1990-08-09",
  "1993-12-04",
  "1976-06-21",
] as const;

const pick = <T>(list: readonly T[], random: RandomInt): T => list[random(list.length)] as T;

/** `user-` and 8 random lowercase letters or digits, for example `user-x7k2m9qa`. */
export function newUsername(random: RandomInt = cryptoRandomInt): string {
  let handle = "";
  for (let i = 0; i < HANDLE_LENGTH; i++) handle += pick([...HANDLE_ALPHABET], random);
  return ACCESS_USERNAME_PREFIX + handle;
}

export interface SyntheticIdentity {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
}

export function newIdentity(random: RandomInt = cryptoRandomInt): SyntheticIdentity {
  return {
    firstName: pick(FIRST_NAMES, random),
    lastName: pick(LAST_NAMES, random),
    dateOfBirth: pick(BIRTH_DATES, random),
  };
}

// Without 0/O, 1/l/I, so a reviewer can read the password off the page and type it.
const LOWER = "abcdefghjkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const PASSWORD_LENGTH = 16;

/**
 * A random password for the pool's policy (infra/stacks/auth.yaml): 16 characters with at least one lowercase
 * letter, one uppercase letter and one number, about 90 bits. The three required characters go first and a
 * Fisher-Yates shuffle spreads them.
 */
export function newPassword(random: RandomInt = cryptoRandomInt): string {
  const all = [...LOWER, ...UPPER, ...DIGITS];
  const chars = [pick([...LOWER], random), pick([...UPPER], random), pick([...DIGITS], random)];
  while (chars.length < PASSWORD_LENGTH) chars.push(pick(all, random));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join("");
}
