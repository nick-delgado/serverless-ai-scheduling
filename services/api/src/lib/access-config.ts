/**
 * Environment configuration for the request-access Lambda (#357), read once per execution environment. A bad
 * value fails the cold start loudly instead of the first reviewer's request.
 */
import {
  DEFAULT_ACCESS_ACTIVE_CAP,
  DEFAULT_ACCESS_DAILY_CAP,
  DEFAULT_ACCESS_EXPIRY_HOURS,
  type AccessConfig,
} from "./issue-access";
import { positiveIntEnv, requireEnv, type Env } from "./env";

export interface RequestAccessConfig extends AccessConfig {
  /** The single table (`/sched/<env>/data/table-name`). */
  tableName: string;
  /** The env's User Pool ID (`/sched/<env>/auth/user-pool-id`). */
  userPoolId: string;
  /** The Turnstile secret key (NoEcho `TurnstileSecret`). Never logged. */
  turnstileSecret: string;
  /** The hostname Cloudflare must report; empty means not checked. */
  expectedHostname: string;
}

export function requestAccessConfigFromEnv(env: Env = process.env): RequestAccessConfig {
  return {
    tableName: requireEnv(env, "TABLE_NAME"),
    userPoolId: requireEnv(env, "USER_POOL_ID"),
    turnstileSecret: requireEnv(env, "TURNSTILE_SECRET"),
    expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME?.trim() ?? "",
    caps: {
      daily: positiveIntEnv(env, "ACCESS_DAILY_CAP", DEFAULT_ACCESS_DAILY_CAP),
      active: positiveIntEnv(env, "ACCESS_ACTIVE_CAP", DEFAULT_ACCESS_ACTIVE_CAP),
    },
    expiryHours: positiveIntEnv(env, "ACCESS_EXPIRY_HOURS", DEFAULT_ACCESS_EXPIRY_HOURS),
  };
}
