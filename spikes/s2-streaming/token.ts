/**
 * Prints an ID token for the skeleton test user, for ad-hoc curl checks (see README.md). The token
 * is valid for 60 minutes; never paste it into files, issues, or PRs.
 *
 *   AWS_PROFILE=sched-dev AWS_REGION=us-east-1 npx tsx spikes/s2-streaming/token.ts [env]
 */
import { loadConfig, signIn } from "./common";

process.stdout.write(`${await signIn(loadConfig(process.argv[2] ?? "dev"))}\n`);
