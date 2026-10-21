/**
 * Environment configuration for the expiry job (#357, part 2), read once per execution environment. A missing value
 * fails the cold start loudly instead of the first scheduled run.
 */
import { requireEnv, type Env } from "./env";

export interface ExpiryConfig {
  /** The single table (`/sched/<env>/data/table-name`). */
  tableName: string;
  /** The env's User Pool ID (`/sched/<env>/auth/user-pool-id`). */
  userPoolId: string;
}

export function expiryConfigFromEnv(env: Env = process.env): ExpiryConfig {
  return { tableName: requireEnv(env, "TABLE_NAME"), userPoolId: requireEnv(env, "USER_POOL_ID") };
}
