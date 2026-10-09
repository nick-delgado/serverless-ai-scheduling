/**
 * Writes the git-ignored `.env.local` the page reads: the `dev` User Pool, SPA client and Identity
 * Pool IDs from SSM (r1/A-8). The values are never printed. Run with AWS_PROFILE=sched-dev.
 *
 *   AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npm run config -w spikes/s3-transcribe-browser
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ssm } from "../s2-streaming/common.ts";

const here = dirname(fileURLToPath(import.meta.url));

const env = process.argv[2] ?? "dev";
const values = {
  VITE_USER_POOL_ID: ssm(`/sched/${env}/auth/user-pool-id`),
  VITE_SPA_CLIENT_ID: ssm(`/sched/${env}/auth/spa-client-id`),
  VITE_IDENTITY_POOL_ID: ssm(`/sched/${env}/auth/identity-pool-id`),
};
for (const [name, value] of Object.entries(values)) if (!value) throw new Error(`${name} is empty`);
const file = join(here, ".env.local");
writeFileSync(
  file,
  `${Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`,
  { mode: 0o600 },
);
console.log(
  `Wrote ${Object.keys(values).length} values for ${env} to spikes/s3-transcribe-browser/.env.local (not printed).`,
);
