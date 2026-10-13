/**
 * Before the journeys (#40): pick the env and its URL, refuse a shared env, check the patient is seeded, and open a run
 * directory outside the checkout where the specs list the conversations they start (for `cost-reporter.ts`).
 * The reseed itself is `reseed.sh`, run before Playwright (in `e2e.yml`, its own step), so its output is in the log.
 * Environment variables set here reach the test workers.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertWritableEnv, baseUrlFor, e2eEnv, patientLogin } from "./support/env";

export default async function globalSetup(): Promise<void> {
  const env = e2eEnv();
  assertWritableEnv(env);
  process.env.E2E_BASE_URL = await baseUrlFor(env);
  const login = patientLogin(env);
  process.env.E2E_RUN_DIR = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "sched-e2e-run-"));
  console.log(`E2E: env '${env}', ${process.env.E2E_BASE_URL}, patient ${login.alias} (${login.username})`);
}
