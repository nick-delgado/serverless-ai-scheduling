/**
 * Environment readers shared by every API Lambda. Kept free of `@sched/agent`, so a function that never
 * calls a model (`POST /api/session`, #18) doesn't bundle the agent loop and the Bedrock client.
 */

export type Env = Readonly<Record<string, string | undefined>>;

export function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function positiveIntEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}
