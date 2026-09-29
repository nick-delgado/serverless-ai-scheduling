/**
 * Model profiles (ADR-002): everything that differs per model lives here, so the loop never branches on
 * model names. `AGENT_MODEL_PROFILE` selects one; the model is configuration, not code.
 *
 * All IDs are US cross-region inference profiles on bedrock-runtime (on-demand calls need the `us.`
 * prefix). None of these models takes sampling parameters (`temperature`/`top_p`/`top_k`) in our setup,
 * so `params` can only carry thinking and output config.
 */
import type Anthropic from "@anthropic-ai/sdk";

export const MODEL_PROFILE_NAMES = ["sonnet-4.6", "haiku-4.5", "sonnet-5", "opus-5"] as const;
export type ModelProfileName = (typeof MODEL_PROFILE_NAMES)[number];

/** The environment variable that selects the profile. */
export const MODEL_PROFILE_ENV = "AGENT_MODEL_PROFILE";

/** The development default (ADR-002 interim decision): entitled on this account today. */
export const DEFAULT_MODEL_PROFILE: ModelProfileName = "sonnet-4.6";

export interface ModelProfile {
  /** Recorded in every trace as `modelProfile`. */
  readonly name: ModelProfileName;
  /** Bedrock inference-profile ID. */
  readonly modelId: string;
  /** Per-model request params, spread into every request. */
  readonly params: Readonly<Pick<Anthropic.MessageCreateParamsNonStreaming, "thinking" | "output_config">>;
  /** `max_tokens` for a normal call. Thinking tokens count against it. */
  readonly maxTokens: number;
  /** `max_tokens` for the single retry after a `max_tokens` stop (ADR-001). */
  readonly retryMaxTokens: number;
  /** Profile for the single client-side retry after a refusal (Bedrock has no server-side `fallbacks`). */
  readonly fallback: ModelProfileName;
  /**
   * Smallest prefix the model will cache, in tokens. Shorter prefixes silently don't cache (no error,
   * just zero cache tokens in the trace).
   */
  readonly minCacheableTokens: number;
}

/**
 * The refusal fallback for each profile: the next model in the ADR-002 matrix (Opus 5 → Sonnet 5 →
 * Haiku 4.5), plus the two models this account can call today falling back to each other. Switching
 * models costs a cold cache on the retry (caches are per model), which is fine for a rare event.
 */
export const REFUSAL_FALLBACKS: Readonly<Record<ModelProfileName, ModelProfileName>> = {
  "opus-5": "sonnet-5",
  "sonnet-5": "haiku-4.5",
  "sonnet-4.6": "haiku-4.5",
  "haiku-4.5": "sonnet-4.6",
};

export const MODEL_PROFILES: Readonly<Record<ModelProfileName, ModelProfile>> = {
  /**
   * Development default. Sonnet 4.6 runs WITHOUT thinking unless adaptive thinking is set explicitly.
   * Spike S-1: 10/10 correct tool calls, full turn p50 5.16 s, and it caches our ~2.1k-token prefix.
   */
  "sonnet-4.6": {
    name: "sonnet-4.6",
    modelId: "us.anthropic.claude-sonnet-4-6",
    params: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["sonnet-4.6"],
    minCacheableTokens: 1_024,
  },
  /**
   * Fastest and cheapest. No `effort` (Haiku 4.5 rejects it) and thinking off. Its 4,096-token cache
   * minimum is above our tools + system prefix (~2.6k tokens), so that breakpoint never caches here;
   * only the conversation breakpoint can, once history pushes the prefix past 4,096 tokens.
   */
  "haiku-4.5": {
    name: "haiku-4.5",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    params: {},
    maxTokens: 4_000,
    retryMaxTokens: 16_000,
    fallback: REFUSAL_FALLBACKS["haiku-4.5"],
    minCacheableTokens: 4_096,
  },
  /**
   * Target model. NOT ENTITLED on this account yet (403 "not available for this account" until AWS lifts
   * the restriction; ADR-002). Defined now so the switch is config only.
   */
  "sonnet-5": {
    name: "sonnet-5",
    modelId: "us.anthropic.claude-sonnet-5",
    params: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["sonnet-5"],
    minCacheableTokens: 1_024,
  },
  /**
   * Target model. NOT ENTITLED on this account yet (see sonnet-5). Thinking is on by default on Opus 5;
   * never disable it (disabled thinking can leak tool calls into visible text). Tune `effort` instead.
   */
  "opus-5": {
    name: "opus-5",
    modelId: "us.anthropic.claude-opus-5",
    params: { thinking: { type: "adaptive" }, output_config: { effort: "medium" } },
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["opus-5"],
    minCacheableTokens: 512,
  },
};

export function isModelProfileName(value: string): value is ModelProfileName {
  return (MODEL_PROFILE_NAMES as readonly string[]).includes(value);
}

/** The profile with this name, or the default when the name is empty or missing. Throws on an unknown name. */
export function resolveModelProfile(name: string | undefined): ModelProfile {
  const key = name?.trim() || DEFAULT_MODEL_PROFILE;
  if (!isModelProfileName(key)) {
    throw new Error(
      `Unknown ${MODEL_PROFILE_ENV} "${key}". Expected one of: ${MODEL_PROFILE_NAMES.join(", ")}.`,
    );
  }
  return MODEL_PROFILES[key];
}

/** The profile selected by `AGENT_MODEL_PROFILE` in `env` (default: `process.env`). */
export function modelProfileFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelProfile {
  return resolveModelProfile(env[MODEL_PROFILE_ENV]);
}

/** The profile to retry on after a refusal on `profile`. */
export function fallbackProfileFor(profile: ModelProfile): ModelProfile {
  return MODEL_PROFILES[profile.fallback];
}
