/**
 * Where the suite runs and as whom (#40). Read in the Playwright processes, never in the browser.
 *
 * - Env: `E2E_ENV`, default `e2e`. The journeys book, reschedule and escalate, so they refuse `dev` and `demo`
 *   (`assertWritableEnv`, called by `global-setup.ts`); only the read-only FR-010 measurement (`fr010.config.ts`)
 *   targets `dev`.
 * - URL: `E2E_BASE_URL`, else `https://<SSM /sched/<env>/web/domain>`.
 * - Patient: the E2E patient's row in `.seed/cognito-users.<env>.json`, which `scripts/seed-users.ts` writes (its
 *   username and Cognito `sub`), its first name from the clinic fixture, and its password from `DEMO_PASSWORD_<FIRST>`:
 *   the environment (the `e2e` GitHub Environment's secret in CI), else the main checkout's git-ignored `.env`. Never
 *   printed.
 * - AWS: `sched-dev` locally (AWS_PROFILE / AWS_REGION defaults, like the seed scripts); in `e2e.yml`, the E2E role's
 *   credentials from the environment, with `AWS_PROFILE` set but empty, which the default keeps (r1/A-1).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

import type { FixturePatientAlias } from "@sched/tools/fixtures";

import { ENV_PATTERN, ssmClientFor, ssmParamFrom } from "../../../../scripts/seed-data";
import { mappingPath, passwordVar, planDemoUsers, readMapping } from "../../../../scripts/seed-users";
import { E2E_PATIENT, fixtureFirstName } from "../lib/plan";

/**
 * Envs the journeys never write to (CLAUDE.md: shared data needs Nick's approval). A copy of `PROTECTED_ENVS` in
 * `scripts/deploy.sh` (and `teardown.sh`, `deploy-web.sh`); keep them in sync.
 */
const SHARED_ENVS = ["dev", "demo"];

/**
 * The seed scripts' defaults, `sched-dev` / `us-east-1`, for variables that are unset. An `AWS_PROFILE` set but empty
 * stays empty: `e2e.yml` sets it so, and the SDK then takes the role's credentials from the environment (r1/A-1).
 */
export function awsDefaults(): void {
  process.env.AWS_PROFILE ??= "sched-dev";
  process.env.AWS_REGION ??= "us-east-1";
}

export function e2eEnv(): string {
  const env = process.env.E2E_ENV ?? "e2e";
  if (!ENV_PATTERN.test(env)) throw new Error(`invalid E2E_ENV: ${env}`);
  return env;
}

export function assertWritableEnv(env: string): void {
  if (SHARED_ENVS.includes(env)) {
    throw new Error(`The E2E journeys write to the table; they don't run against the shared '${env}' env.`);
  }
}

/** SSM `/sched/<env>/<name>`, read as the seed scripts read it. */
export async function ssmParam(env: string, name: string): Promise<string> {
  awsDefaults();
  return ssmParamFrom(ssmClientFor(process.env.AWS_REGION ?? "us-east-1"))(env, name);
}

/** The app's origin for `env`, without a trailing slash. */
export async function baseUrlFor(env: string): Promise<string> {
  const explicit = process.env.E2E_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return `https://${await ssmParam(env, "web/domain")}`;
}

/** `path` on the app, from `E2E_BASE_URL` (global setup sets it for the workers). */
export function appUrl(path: string): string {
  const base = process.env.E2E_BASE_URL;
  if (!base) throw new Error("E2E_BASE_URL is not set; run the suite through its Playwright config");
  return `${base}${path}`;
}

/** A demo patient's sign-in, and the first name the greeting uses. */
export interface FixtureLogin {
  username: string;
  password: string;
  firstName: string;
}

export interface PatientLogin extends FixtureLogin {
  alias: FixturePatientAlias;
  /** The Cognito `sub`: the patient ID in the table. */
  sub: string;
}

/** Where the logins are read from; tests point these at temp files. */
export interface LoginSources {
  /** The seed mapping (default `mappingPath(env)`). */
  mapping?: string;
  /** The `.env` read when the environment has no password (default: the main checkout's). */
  envFile?: string;
}

const mainCheckoutEnvFile = (): string =>
  join(
    dirname(
      execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
      }).trim(),
    ),
    ".env",
  );

/** `DEMO_PASSWORD_<FIRST>` from the environment, else from `envFile`. Errors name the variable, never its value. */
function password(alias: FixturePatientAlias, envFile: string | undefined): string {
  const name = passwordVar(alias);
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const file = envFile ?? mainCheckoutEnvFile();
  let value: string | undefined;
  try {
    value = parseEnv(readFileSync(file, "utf8"))[name];
  } catch {
    value = undefined;
  }
  if (!value) throw new Error(`${name} is not set (environment, or ${file})`);
  return value;
}

/** The E2E patient's seeded login on `env`. Throws when the mapping has no row for it (run the reseed first). */
export function patientLogin(env: string, sources: LoginSources = {}): PatientLogin {
  const path = sources.mapping ?? mappingPath(env);
  const row = readMapping(path)?.users.find((u) => u.alias === E2E_PATIENT);
  if (!row) {
    throw new Error(`No ${E2E_PATIENT} row in ${path}; reseed first (scripts/seed-users.ts --env ${env})`);
  }
  return {
    alias: E2E_PATIENT,
    username: row.username,
    sub: row.sub,
    password: password(E2E_PATIENT, sources.envFile),
    firstName: fixtureFirstName(E2E_PATIENT),
  };
}

/**
 * The sign-in of `alias`, without the env's mapping (the FR-010 run signs in on `dev`, whose mapping lives in the main
 * checkout). The username follows `scripts/seed-users.ts`'s rule.
 */
export function fixtureLogin(
  alias: FixturePatientAlias,
  sources: Pick<LoginSources, "envFile"> = {},
): FixtureLogin {
  const [spec] = planDemoUsers({ [passwordVar(alias)]: password(alias, sources.envFile) });
  if (!spec) throw new Error(`No demo user for ${alias}`);
  return { username: spec.username, password: spec.password, firstName: spec.givenName };
}
