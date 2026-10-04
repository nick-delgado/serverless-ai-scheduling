/**
 * Environment configuration for the API Lambdas, read once per execution environment. A bad value fails
 * the cold start loudly instead of the first patient request.
 */
import { modelProfileFromEnv, type ModelProfile } from "@sched/agent";

import { DEFAULT_DAILY_TURN_CAP } from "./chat-turn";
import { positiveIntEnv, requireEnv, type Env } from "./env";

export { positiveIntEnv, requireEnv, type Env } from "./env";

export interface ChatConfig {
  /** The single table (`/sched/<env>/data/table-name`). */
  tableName: string;
  /** `AGENT_MODEL_PROFILE`, default `sonnet-4.6` (ADR-010). */
  profile: ModelProfile;
  /** `DAILY_TURN_CAP`, default 50 (ADR-009). */
  dailyTurnCap: number;
}

export function chatConfigFromEnv(env: Env = process.env): ChatConfig {
  return {
    tableName: requireEnv(env, "TABLE_NAME"),
    profile: modelProfileFromEnv(env),
    dailyTurnCap: positiveIntEnv(env, "DAILY_TURN_CAP", DEFAULT_DAILY_TURN_CAP),
  };
}
