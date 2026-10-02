/**
 * Create the demo patients in an env's Cognito User Pool (S1-01 #12, ADR-005).
 *
 *   npx tsx scripts/seed-users.ts [--env dev] [--verify] [--env-file .env]
 *
 * - Who: the synthetic clinic-default fixture patients (`@sched/tools/fixtures`), never real people.
 *   A patient is seeded only when the git-ignored `.env` sets their password, e.g.
 *   `DEMO_PASSWORD_MARIA` for `pat-maria`. Usernames are `<first>.<last>` (`maria.santos`).
 *   See `.env.example`.
 * - How: `AdminCreateUser` (no invitation message) then `AdminSetUserPassword --permanent`, so the
 *   user signs in with SRP straight away. Re-running is safe: an existing user keeps its `sub` and
 *   gets its password reset to the one in `.env`.
 * - Output: `.seed/cognito-users.<env>.json` (git-ignored), mapping each fixture alias and fixture
 *   patient ID to the Cognito `sub`. The data seed (S2-02 #14) keys `PATIENT#<sub>` profiles on it,
 *   because the API reads the patient ID from the verified token's `sub` (CLAUDE.md rule 1).
 * - `--verify` signs every seeded user in with USER_SRP_AUTH and checks the ID token's `sub`
 *   matches the mapping. It prints no tokens and no passwords.
 *
 * Runs as the `sched-dev` SSO profile (AWS_PROFILE / AWS_REGION, defaults `sched-dev` / `us-east-1`).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { buildClinicFixture, FIXTURE_PATIENT_IDS, type FixturePatientAlias } from "@sched/tools/fixtures";

export const PASSWORD_VAR_PREFIX = "DEMO_PASSWORD_";

export interface DemoUserSpec {
  alias: FixturePatientAlias;
  fixturePatientId: string;
  username: string;
  givenName: string;
  familyName: string;
  password: string;
}

export interface SeededUser {
  alias: FixturePatientAlias;
  fixturePatientId: string;
  username: string;
  /** Cognito `sub`: the patient ID the API sees for this user. */
  sub: string;
}

export interface UserMapping {
  env: string;
  userPoolId: string;
  updatedAt: string;
  users: SeededUser[];
}

/** `pat-maria` → `DEMO_PASSWORD_MARIA`. */
export function passwordVar(alias: FixturePatientAlias): string {
  return PASSWORD_VAR_PREFIX + alias.replace(/^pat-/, "").toUpperCase();
}

/** Mirrors the User Pool's policy in infra/stacks/auth.yaml, so a bad .env fails before any AWS call. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("is shorter than 12 characters");
  if (!/[a-z]/.test(password)) problems.push("has no lowercase letter");
  if (!/[A-Z]/.test(password)) problems.push("has no uppercase letter");
  if (!/[0-9]/.test(password)) problems.push("has no number");
  return problems;
}

/**
 * Which fixture patients to seed, from env vars (normally the loaded `.env`). Throws on a password
 * that breaks the policy, a `DEMO_PASSWORD_*` var that names no fixture patient, or no users at all.
 * Error messages name the variable, never its value.
 */
export function planDemoUsers(vars: Readonly<Record<string, string | undefined>>): DemoUserSpec[] {
  const aliasByPatientId = new Map<string, FixturePatientAlias>(
    Object.entries(FIXTURE_PATIENT_IDS).map(([alias, id]) => [id, alias as FixturePatientAlias]),
  );
  const errors: string[] = [];
  const specs: DemoUserSpec[] = [];
  const known = new Set<string>();

  for (const patient of buildClinicFixture().patients) {
    const alias = aliasByPatientId.get(patient.patientId);
    if (!alias) continue;
    const name = passwordVar(alias);
    known.add(name);
    const password = vars[name];
    if (!password) continue;
    const problems = passwordProblems(password);
    if (problems.length > 0) {
      errors.push(`${name} ${problems.join(", ")}`);
      continue;
    }
    specs.push({
      alias,
      fixturePatientId: patient.patientId,
      username: `${patient.firstName}.${patient.lastName}`.toLowerCase(),
      givenName: patient.firstName,
      familyName: patient.lastName,
      password,
    });
  }

  for (const name of Object.keys(vars)) {
    if (name.startsWith(PASSWORD_VAR_PREFIX) && !known.has(name)) {
      errors.push(`${name} names no fixture patient (expected one of ${[...known].join(", ")})`);
    }
  }
  if (errors.length > 0) throw new Error(`Invalid demo-user config:\n  - ${errors.join("\n  - ")}`);
  if (specs.length === 0) {
    throw new Error(`No demo users configured: set at least one of ${[...known].join(", ")} in .env`);
  }
  return specs;
}

/** The three User Pool admin operations the seed needs, so tests can run without AWS. */
export interface CognitoAdmin {
  /** Creates the user without sending any message. Resolves false when the username already exists. */
  createUser(spec: DemoUserSpec): Promise<boolean>;
  getSub(username: string): Promise<string>;
  setPermanentPassword(username: string, password: string): Promise<void>;
}

export function cognitoAdmin(client: CognitoIdentityProviderClient, userPoolId: string): CognitoAdmin {
  return {
    async createUser(spec) {
      try {
        await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: spec.username,
            MessageAction: "SUPPRESS",
            UserAttributes: [
              { Name: "given_name", Value: spec.givenName },
              { Name: "family_name", Value: spec.familyName },
            ],
          }),
        );
        return true;
      } catch (err) {
        if (err instanceof UsernameExistsException) return false;
        throw err;
      }
    },
    async getSub(username) {
      const out = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
      const sub = out.UserAttributes?.find((a) => a.Name === "sub")?.Value;
      if (!sub) throw new Error(`User ${username} has no sub attribute`);
      return sub;
    },
    async setPermanentPassword(username, password) {
      await client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: username,
          Password: password,
          Permanent: true,
        }),
      );
    },
  };
}

/** Creates (or finds) each user, sets the permanent password, and returns the alias → sub rows. */
export async function seedUsers(
  admin: CognitoAdmin,
  specs: readonly DemoUserSpec[],
  log: (line: string) => void = () => undefined,
): Promise<SeededUser[]> {
  const seeded: SeededUser[] = [];
  for (const spec of specs) {
    const created = await admin.createUser(spec);
    await admin.setPermanentPassword(spec.username, spec.password);
    const sub = await admin.getSub(spec.username);
    log(`${created ? "created" : "exists "} ${spec.alias.padEnd(10)} ${spec.username.padEnd(16)} sub=${sub}`);
    seeded.push({ alias: spec.alias, fixturePatientId: spec.fixturePatientId, username: spec.username, sub });
  }
  return seeded;
}

/**
 * Merges this run's users into the previous mapping. Rows for users not seeded this time are kept
 * (they still exist in Cognito) unless the previous mapping belongs to a different User Pool, e.g.
 * an ephemeral env that was torn down and recreated, whose subs are all gone.
 */
export function mergeMapping(
  previous: UserMapping | undefined,
  target: { env: string; userPoolId: string },
  seeded: readonly SeededUser[],
  now: Date,
): UserMapping {
  const rows = new Map<string, SeededUser>();
  if (previous?.userPoolId === target.userPoolId) for (const u of previous.users) rows.set(u.alias, u);
  for (const u of seeded) rows.set(u.alias, u);
  const users = [...rows.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  return { env: target.env, userPoolId: target.userPoolId, updatedAt: now.toISOString(), users };
}

/** USER_SRP_AUTH as the user; resolves with the verified-session ID token's `sub`. */
export async function srpSignInSub(
  pool: { userPoolId: string; clientId: string },
  username: string,
  password: string,
): Promise<string> {
  const { AuthenticationDetails, CognitoUser, CognitoUserPool } = await import("amazon-cognito-identity-js");
  const user = new CognitoUser({
    Username: username,
    Pool: new CognitoUserPool({ UserPoolId: pool.userPoolId, ClientId: pool.clientId }),
  });
  return new Promise((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: username, Password: password }), {
      onSuccess: (session) => {
        const claims = session.getIdToken().decodePayload() as Record<string, unknown>;
        if (claims.token_use !== "id" || typeof claims.sub !== "string") {
          reject(new Error(`unexpected ID token claims for ${username}`));
        } else resolve(claims.sub);
      },
      onFailure: (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))),
      newPasswordRequired: () => reject(new Error(`${username} still needs a new password`)),
    });
  });
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function mappingPath(env: string): string {
  return join(repoRoot, ".seed", `cognito-users.${env}.json`);
}

function readMapping(path: string): UserMapping | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UserMapping;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      env: { type: "string", default: "dev" },
      "env-file": { type: "string", default: join(repoRoot, ".env") },
      verify: { type: "boolean", default: false },
    },
  });
  const env = values.env;
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(env)) throw new Error(`invalid env: ${env}`);
  process.env.AWS_PROFILE ??= "sched-dev";
  const region = (process.env.AWS_REGION ??= "us-east-1");

  process.loadEnvFile(values["env-file"]);
  const specs = planDemoUsers(process.env);

  const ssm = new SSMClient({ region });
  const param = async (name: string): Promise<string> => {
    const out = await ssm.send(new GetParameterCommand({ Name: `/sched/${env}/auth/${name}` }));
    if (!out.Parameter?.Value) throw new Error(`SSM /sched/${env}/auth/${name} is empty`);
    return out.Parameter.Value;
  };
  const userPoolId = await param("user-pool-id");

  console.log(`Seeding ${specs.length} demo user(s) into env '${env}'`);
  const seeded = await seedUsers(
    cognitoAdmin(new CognitoIdentityProviderClient({ region }), userPoolId),
    specs,
    (line) => console.log(`  ${line}`),
  );

  const path = mappingPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const mapping = mergeMapping(readMapping(path), { env, userPoolId }, seeded, new Date());
  writeFileSync(path, `${JSON.stringify(mapping, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote ${relative(process.cwd(), path)} (${mapping.users.length} user(s))`);

  if (values.verify) {
    const clientId = await param("spa-client-id");
    for (const spec of specs) {
      const sub = await srpSignInSub({ userPoolId, clientId }, spec.username, spec.password);
      const expected = seeded.find((u) => u.alias === spec.alias)?.sub;
      if (sub !== expected) throw new Error(`${spec.username}: token sub ${sub} != mapping sub ${expected}`);
      console.log(`  verified ${spec.username}: USER_SRP_AUTH ok, ID token sub matches`);
    }
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
