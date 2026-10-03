/**
 * Load the clinic-default fixture into an env's DynamoDB table (S2-02 #14, ADR-004, ADR-005).
 *
 *   npx tsx scripts/seed-data.ts --env dev [--reset [--confirm <table-name>]] [--table <name>] [--mapping <path>]
 *
 * - What: the 8 fixture providers, 4 weeks of 30-minute slots starting **today on the clinic's wall clock**
 *   (America/New_York), the patient profiles, and the fixture's sample appointments, all synthetic.
 * - Who: only the fixture patients listed in the Cognito mapping that `scripts/seed-users.ts` writes
 *   (`.seed/cognito-users.<env>.json`). Every fixture patient ID is rewritten to that patient's Cognito
 *   `sub`, the ID the API reads from the verified token (CLAUDE.md rule 1). Fixture patients with no
 *   mapping row are skipped with their appointments, and the slots those appointments held stay OPEN.
 * - Re-running is safe: a normal run only **adds** what is missing. Slots and appointments that already
 *   exist (including bookings the agent made since) are never overwritten. Provider and patient profiles
 *   are rewritten with the same content (a profile keeps its original `createdAt`). Running on a later
 *   day extends the slot window to 4 weeks from that day; earlier slots stay.
 * - `--reset` first deletes what this seed owns: every item in the fixture providers' partitions (profiles
 *   and all slots) and, for each mapped patient, the profile and every appointment (agent-made ones too).
 *   Conversations are kept. It asks you to type the table name, or takes it as `--confirm <table-name>`;
 *   without either (e.g. no terminal) it refuses before touching the table.
 * - Table: SSM `/sched/<env>/data/table-name`, or `--table`. The mapping's `userPoolId` must match SSM
 *   `/sched/<env>/auth/user-pool-id`, so subs from a deleted pool are never written.
 * - Local: with `DYNAMODB_ENDPOINT` set (DynamoDB Local), `--table` is required and no SSM call is made.
 *
 * Runs as the `sched-dev` SSO profile (AWS_PROFILE / AWS_REGION, defaults `sched-dev` / `us-east-1`).
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  paginateQuery,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { Appointment, Patient, Slot } from "@sched/contracts";
import { type ClinicSeed, clinicDateOf } from "@sched/tools";
import { createDocumentClient, keys, writeSeed } from "@sched/tools/dynamo";
import { buildClinicFixture, FIXTURE_PATIENT_IDS, type FixturePatientAlias } from "@sched/tools/fixtures";

import { mappingPath, readMapping, type UserMapping } from "./seed-users";

/** Slots cover `[today, today + 7 * SEED_WEEKS)` in clinic-local days. */
export const SEED_WEEKS = 4;

const ENV_PATTERN = /^[a-z][a-z0-9-]{1,15}$/;

// ---------------------------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------------------------

/**
 * The mapping at `path`, checked against the target env (and User Pool, when known). Throws when the
 * file is missing (run seed-users first), unreadable or malformed (`readMapping`), for another env or
 * pool, empty, or when a row's `fixturePatientId` is not its alias's fixture ID.
 */
export function loadMapping(path: string, target: { env: string; userPoolId?: string }): UserMapping {
  const mapping = readMapping(path);
  if (!mapping) {
    throw new Error(
      `No user mapping at ${path}. Run \`npx tsx scripts/seed-users.ts --env ${target.env}\` first.`,
    );
  }
  if (mapping.env !== target.env) {
    throw new Error(`The user mapping ${path} is for env '${mapping.env}', not '${target.env}'`);
  }
  if (target.userPoolId !== undefined && mapping.userPoolId !== target.userPoolId) {
    throw new Error(
      `The user mapping ${path} is for User Pool ${mapping.userPoolId}, but env '${target.env}' uses ` +
        `${target.userPoolId}. Re-run seed-users.ts for this env.`,
    );
  }
  if (mapping.users.length === 0) throw new Error(`The user mapping ${path} lists no users`);
  for (const u of mapping.users) {
    if (FIXTURE_PATIENT_IDS[u.alias] !== u.fixturePatientId) {
      throw new Error(`The user mapping ${path}: ${u.alias} has fixturePatientId ${u.fixturePatientId}`);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

export interface DataSeed {
  seed: ClinicSeed;
  /** First clinic-local day of the slot window. */
  baseDate: string;
  /** Fixture patients left out because the mapping has no row for them. */
  skipped: FixturePatientAlias[];
}

/**
 * The clinic-default fixture for a 4-week window starting at `now`'s clinic-local date, keeping only the
 * mapped patients, with every patient ID rewritten to the Cognito `sub`. Appointments of unmapped patients
 * are dropped and the slots they held reopened.
 */
export function buildDataSeed(mapping: UserMapping, now: Date): DataSeed {
  const baseDate = clinicDateOf(now);
  const fixture = buildClinicFixture({ baseDate, weeks: SEED_WEEKS });
  const subOf = new Map(mapping.users.map((u) => [u.fixturePatientId, u.sub]));

  const patients: Patient[] = [];
  for (const p of fixture.patients) {
    const sub = subOf.get(p.patientId);
    if (sub !== undefined) patients.push({ ...p, patientId: sub });
  }

  const appointments: Appointment[] = [];
  const dropped = new Set<string>();
  for (const a of fixture.appointments) {
    const sub = subOf.get(a.patientId);
    if (sub === undefined) dropped.add(a.appointmentId);
    else appointments.push({ ...a, patientId: sub });
  }

  const slots = fixture.slots.map((s) => (s.appointmentId && dropped.has(s.appointmentId) ? openSlot(s) : s));

  const skipped = (Object.keys(FIXTURE_PATIENT_IDS) as FixturePatientAlias[]).filter(
    (alias) => !subOf.has(FIXTURE_PATIENT_IDS[alias]),
  );
  return { seed: { patients, providers: fixture.providers, slots, appointments }, baseDate, skipped };
}

function openSlot(slot: Slot): Slot {
  const { appointmentId: _held, ...rest } = slot;
  return { ...rest, status: "OPEN" };
}

/** What the table already holds of a seed: item keys (`PK|SK`) and each existing profile's `createdAt`. */
export interface ExistingItems {
  keys: ReadonlySet<string>;
  patientCreatedAt: ReadonlyMap<string, string>;
}

const keyString = (k: { PK: string; SK: string }): string => `${k.PK}|${k.SK}`;

/**
 * The part of `seed` a normal (non-reset) run writes, so re-running never overwrites live state:
 * - providers and patients: all of them (same content; a patient keeps the stored `createdAt`);
 * - slots: only those not stored yet;
 * - appointments: only those not stored yet, and a BOOKED one only if its slot is not stored yet either
 *   (a stored slot may be OPEN or booked by someone else since). A slot whose appointment is skipped is
 *   written OPEN, if it is written at all.
 */
export function planTopUp(seed: ClinicSeed, existing: ExistingItems): ClinicSeed {
  const has = (k: { PK: string; SK: string }): boolean => existing.keys.has(keyString(k));
  const appointments = seed.appointments.filter(
    (a) =>
      !has(keys.appointment(a.patientId, a.appointmentId)) &&
      (a.status !== "BOOKED" || !has(keys.slot(a.providerId, a.startUtc))),
  );
  const kept = new Set(appointments.map((a) => a.appointmentId));
  const slots = seed.slots
    .filter((s) => !has(keys.slot(s.providerId, s.startUtc)))
    .map((s) => (s.appointmentId && !kept.has(s.appointmentId) ? openSlot(s) : s));
  const patients = seed.patients.map((p) => {
    const createdAt = existing.patientCreatedAt.get(p.patientId);
    return createdAt === undefined ? p : { ...p, createdAt };
  });
  return { patients, providers: seed.providers, slots, appointments };
}

// ---------------------------------------------------------------------------------------------
// Table access
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

async function queryAll(doc: DynamoDBDocumentClient, input: QueryCommandInput): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const page of paginateQuery({ client: doc }, input)) rows.push(...(page.Items ?? []));
  return rows;
}

/** Query one partition, optionally narrowed by a sort-key condition (`SK = :sk` or `begins_with`). */
const partitionQuery = (
  TableName: string,
  pk: string,
  sk?: { op: "=" | "begins_with"; value: string },
): QueryCommandInput => ({
  TableName,
  ConsistentRead: true,
  KeyConditionExpression:
    sk === undefined
      ? "PK = :pk"
      : sk.op === "="
        ? "PK = :pk AND SK = :sk"
        : "PK = :pk AND begins_with(SK, :sk)",
  ExpressionAttributeValues: sk === undefined ? { ":pk": pk } : { ":pk": pk, ":sk": sk.value },
  ProjectionExpression: "PK, SK, #createdAt",
  ExpressionAttributeNames: { "#createdAt": "createdAt" },
});

/**
 * The seed-owned items stored now: the fixture providers' whole partitions (profile + slots), and each
 * mapped patient's profile and appointments (not their CONV# conversations).
 */
async function ownedRows(doc: DynamoDBDocumentClient, tableName: string, seed: ClinicSeed): Promise<Row[]> {
  const queries = [
    ...seed.providers.map((p) => partitionQuery(tableName, keys.provider(p.providerId).PK)),
    ...seed.patients.flatMap((p) => {
      const pk = keys.patient(p.patientId).PK;
      return [
        partitionQuery(tableName, pk, { op: "=", value: "PROFILE" }),
        partitionQuery(tableName, pk, { op: "begins_with", value: "APPT#" }),
      ];
    }),
  ];
  return (await Promise.all(queries.map((q) => queryAll(doc, q)))).flat();
}

export async function readExisting(
  doc: DynamoDBDocumentClient,
  tableName: string,
  seed: ClinicSeed,
): Promise<ExistingItems> {
  const rows = await ownedRows(doc, tableName, seed);
  const byKey = new Map(rows.map((r) => [keyString({ PK: String(r.PK), SK: String(r.SK) }), r]));
  const patientCreatedAt = new Map<string, string>();
  for (const p of seed.patients) {
    const createdAt = byKey.get(keyString(keys.patient(p.patientId)))?.createdAt;
    if (typeof createdAt === "string") patientCreatedAt.set(p.patientId, createdAt);
  }
  return { keys: new Set(byKey.keys()), patientCreatedAt };
}

/** Most `BatchWriteItem` calls per batch of 25 deletes before `deleteRows` gives up. */
export const DELETE_MAX_ATTEMPTS = 8;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Delete `rows` by key in batches of 25, re-sending the deletes DynamoDB returns as unprocessed after
 * waiting `50 * 2^attempt` ms, at most `DELETE_MAX_ATTEMPTS` calls per batch. `wait` is injectable so tests
 * don't sleep.
 */
export async function deleteRows(
  doc: Pick<DynamoDBDocumentClient, "send">,
  tableName: string,
  rows: readonly Row[],
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 25) {
    let requests: { DeleteRequest: { Key: Row } }[] = rows
      .slice(i, i + 25)
      .map((r) => ({ DeleteRequest: { Key: { PK: r.PK, SK: r.SK } } }));
    for (let attempt = 1; requests.length > 0; attempt++) {
      if (attempt > DELETE_MAX_ATTEMPTS)
        throw new Error(`reset: ${requests.length} deletes still unprocessed`);
      const out = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: requests } }));
      requests = (out.UnprocessedItems?.[tableName] ?? []).flatMap((r) =>
        r.DeleteRequest?.Key ? [{ DeleteRequest: { Key: r.DeleteRequest.Key } }] : [],
      );
      if (requests.length > 0) await wait(50 * 2 ** attempt);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

export interface SeedDataOptions {
  tableName: string;
  client: DynamoDBClient;
  mapping: UserMapping;
  now: Date;
  /** Delete the seed-owned items first. Requires `confirmReset` to resolve true. */
  reset?: boolean;
  confirmReset?: () => Promise<boolean>;
  log?: (line: string) => void;
}

export interface SeedDataResult {
  baseDate: string;
  skipped: FixturePatientAlias[];
  deleted: number;
  written: number;
}

export async function seedData(options: SeedDataOptions): Promise<SeedDataResult> {
  const log = options.log ?? (() => undefined);
  const { seed, baseDate, skipped } = buildDataSeed(options.mapping, options.now);
  if (options.reset && !(await options.confirmReset?.())) {
    throw new Error("--reset was not confirmed; nothing was changed");
  }
  const doc = createDocumentClient(options.client);

  let deleted = 0;
  if (options.reset) {
    const rows = await ownedRows(doc, options.tableName, seed);
    await deleteRows(doc, options.tableName, rows);
    deleted = rows.length;
    log(`deleted ${deleted} seed-owned item(s)`);
  }

  const toWrite = planTopUp(seed, await readExisting(doc, options.tableName, seed));
  const { itemsWritten } = await writeSeed({
    tableName: options.tableName,
    client: options.client,
    seed: toWrite,
  });
  log(
    `wrote ${itemsWritten} item(s): ${toWrite.providers.length} providers, ${toWrite.patients.length} patients, ` +
      `${toWrite.slots.length} new slots, ${toWrite.appointments.length} new appointments ` +
      `(window ${baseDate} + ${SEED_WEEKS} weeks)`,
  );
  if (skipped.length > 0) log(`skipped unmapped fixture patients: ${skipped.join(", ")}`);
  return { baseDate, skipped, deleted, written: itemsWritten };
}

/**
 * Whether `--reset` may go ahead: `--confirm` must equal the table name; without it, `ask` (an interactive
 * prompt, absent when there is no terminal) must return the table name.
 */
export async function resetConfirmed(
  tableName: string,
  confirmFlag: string | undefined,
  ask: ((question: string) => Promise<string>) | undefined,
): Promise<boolean> {
  if (confirmFlag !== undefined) return confirmFlag === tableName;
  if (!ask) return false;
  const answer = await ask(
    `--reset deletes the seed-owned items (providers, slots, mapped patients' profiles and appointments) ` +
      `in ${tableName}. Type the table name to confirm: `,
  );
  return answer.trim() === tableName;
}

export interface CliArgs {
  env: string;
  reset: boolean;
  confirm?: string;
  table?: string;
  mapping?: string;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      env: { type: "string" },
      reset: { type: "boolean", default: false },
      confirm: { type: "string" },
      table: { type: "string" },
      mapping: { type: "string" },
    },
  });
  if (values.env === undefined) throw new Error("--env is required (e.g. --env dev)");
  if (!ENV_PATTERN.test(values.env)) throw new Error(`invalid env: ${values.env}`);
  if (values.confirm !== undefined && !values.reset) throw new Error("--confirm only applies to --reset");
  return {
    env: values.env,
    reset: values.reset,
    confirm: values.confirm,
    table: values.table,
    mapping: values.mapping,
  };
}

export interface CliDeps {
  /** Prompts on the terminal; absent when there is none. */
  ask?: (question: string) => Promise<string>;
  now?: Date;
  /** The SSM client for `region` (default: `ssmClientFor`). */
  ssmClient?: (region: string) => Pick<SSMClient, "send">;
  /** The DynamoDB client for `region` and the local endpoint, if any (default: `dynamoClientFor`). */
  dynamoClient?: (region: string, endpoint: string | undefined) => DynamoDBClient;
}

/** A reader of `/sched/<env>/<name>` that throws when the parameter has no value. */
export function ssmParamFrom(ssm: Pick<SSMClient, "send">): (env: string, name: string) => Promise<string> {
  return async (env, name) => {
    const out = await ssm.send(new GetParameterCommand({ Name: `/sched/${env}/${name}` }));
    if (!out.Parameter?.Value) throw new Error(`SSM /sched/${env}/${name} is empty`);
    return out.Parameter.Value;
  };
}

export function ssmClientFor(region: string): SSMClient {
  return new SSMClient({ region });
}

export function dynamoClientFor(region: string, endpoint: string | undefined): DynamoDBClient {
  return endpoint
    ? // DynamoDB Local accepts any credentials.
      new DynamoDBClient({
        endpoint,
        region,
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      })
    : new DynamoDBClient({ region });
}

/**
 * The CLI. `vars` is the process environment. With `DYNAMODB_ENDPOINT` set it needs `--table` and makes
 * no SSM call; otherwise the table name comes from SSM (unless `--table`) and the mapping must belong to
 * the env's current User Pool.
 */
export async function runCli(
  argv: readonly string[],
  vars: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<SeedDataResult> {
  const args = parseCliArgs(argv);
  const endpoint = vars.DYNAMODB_ENDPOINT || undefined;
  const region = vars.AWS_REGION ?? "us-east-1";
  let table: string;
  let userPoolId: string | undefined;
  if (endpoint) {
    if (!args.table) throw new Error("DYNAMODB_ENDPOINT is set: pass --table <name> for the local table");
    table = args.table;
  } else {
    const param = ssmParamFrom((deps.ssmClient ?? ssmClientFor)(region));
    table = args.table ?? (await param(args.env, "data/table-name"));
    userPoolId = await param(args.env, "auth/user-pool-id");
  }

  const mapping = loadMapping(args.mapping ?? mappingPath(args.env), { env: args.env, userPoolId });
  const client = (deps.dynamoClient ?? dynamoClientFor)(region, endpoint);
  console.log(`Seeding env '${args.env}' table ${table}${args.reset ? " (reset)" : ""}`);
  try {
    return await seedData({
      tableName: table,
      client,
      mapping,
      now: deps.now ?? new Date(),
      reset: args.reset,
      confirmReset: () => resetConfirmed(table, args.confirm, deps.ask),
      log: (line) => console.log(`  ${line}`),
    });
  } finally {
    client.destroy();
  }
}

async function terminalAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

if (import.meta.main) {
  process.env.AWS_PROFILE ??= "sched-dev";
  runCli(process.argv.slice(2), process.env, { ask: process.stdin.isTTY ? terminalAsk : undefined }).catch(
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
