/**
 * Where the suite runs and as whom (#40). Read in the Playwright processes, never in the browser.
 *
 * - Env: `E2E_ENV`, default `e2e`. The journeys book, reschedule and escalate, so they refuse `dev` and `demo`
 *   (`assertWritableEnv`); only the read-only FR-010 measurement (`fr010.config.ts`) targets `dev`.
 * - URL: `E2E_BASE_URL`, else `https://<SSM /sched/<env>/web/domain>`.
 * - Patient: the fixture alias's row in `.seed/cognito-users.<env>.json`, which `scripts/seed-users.ts` writes (its
 *   username and Cognito `sub`), and its password from `DEMO_PASSWORD_<FIRST>`: the environment (the `e2e` GitHub
 *   Environment's secret in CI), else the main checkout's git-ignored `.env`. Never printed.
 * - AWS: `sched-dev` locally (AWS_PROFILE / AWS_REGION defaults, like the seed scripts); in `e2e.yml`, the E2E role's
 *   credentials from the environment, with `AWS_PROFILE` empty (r1/A-1).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { FixturePatientAlias } from "@sched/tools/fixtures";

import { mappingPath, passwordVar, planDemoUsers, readMapping } from "../../../../scripts/seed-users";

/** The patient the journeys sign in as, on `e2e` only (r1/Q-1 (a)); #44 picks its demo patients elsewhere. */
export const E2E_PATIENT: FixturePatientAlias = "pat-sofia";

/** Envs the journeys never write to (CLAUDE.md: shared data needs Nick's approval). */
const SHARED_ENVS = ["dev", "demo"];

export function awsDefaults(): void {
  process.env.AWS_PROFILE ??= "sched-dev";
  process.env.AWS_REGION ??= "us-east-1";
}

export function e2eEnv(): string {
  const env = process.env.E2E_ENV ?? "e2e";
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(env)) throw new Error(`invalid E2E_ENV: ${env}`);
  return env;
}

export function assertWritableEnv(env: string): void {
  if (SHARED_ENVS.includes(env)) {
    throw new Error(`The E2E journeys write to the table; they don't run against the shared '${env}' env.`);
  }
}

export async function ssmParam(name: string): Promise<string> {
  awsDefaults();
  const out = await new SSMClient({ region: process.env.AWS_REGION }).send(
    new GetParameterCommand({ Name: name }),
  );
  const value = out.Parameter?.Value;
  if (!value) throw new Error(`SSM ${name} is empty`);
  return value;
}

/** The app's origin for `env`, without a trailing slash. */
export async function baseUrlFor(env: string): Promise<string> {
  const explicit = process.env.E2E_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  return `https://${await ssmParam(`/sched/${env}/web/domain`)}`;
}

/** `path` on the app, from `E2E_BASE_URL` (global setup sets it for the workers). */
export function appUrl(path: string): string {
  const base = process.env.E2E_BASE_URL;
  if (!base) throw new Error("E2E_BASE_URL is not set; run the suite through its Playwright config");
  return `${base}${path}`;
}

export interface PatientLogin {
  alias: FixturePatientAlias;
  username: string;
  /** The Cognito `sub`: the patient ID in the table. */
  sub: string;
  password: string;
}

const mainCheckout = (): string =>
  dirname(
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).trim(),
  );

function password(alias: FixturePatientAlias): string {
  const name = passwordVar(alias);
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const file = join(mainCheckout(), ".env");
  let value: string | undefined;
  try {
    value = parseEnv(readFileSync(file, "utf8"))[name];
  } catch {
    value = undefined;
  }
  if (!value) throw new Error(`${name} is not set (environment, or ${file})`);
  return value;
}

/** The seeded login for `alias` on `env`. Throws when the mapping has no row for it (run the reseed first). */
export function patientLogin(env: string, alias: FixturePatientAlias = E2E_PATIENT): PatientLogin {
  const path = mappingPath(env);
  const row = readMapping(path)?.users.find((u) => u.alias === alias);
  if (!row) throw new Error(`No ${alias} row in ${path}; run apps/web/e2e/reseed.sh first`);
  return { alias, username: row.username, sub: row.sub, password: password(alias) };
}

/**
 * The username and password of `alias`, without the env's mapping (the FR-010 run signs in on `dev`, whose mapping
 * lives in the main checkout). The username follows `scripts/seed-users.ts`'s rule.
 */
export function fixtureLogin(alias: FixturePatientAlias): { username: string; password: string } {
  const [spec] = planDemoUsers({ [passwordVar(alias)]: password(alias) });
  if (!spec) throw new Error(`No demo user for ${alias}`);
  return { username: spec.username, password: spec.password };
}

/** Remembers a conversation this run started, for the cost estimate (`cost-reporter.ts`). */
export function recordConversation(conversationId: string | undefined): void {
  const dir = process.env.E2E_RUN_DIR;
  if (!dir || !conversationId) return;
  appendFileSync(join(dir, "conversations.txt"), `${conversationId}\n`);
}
