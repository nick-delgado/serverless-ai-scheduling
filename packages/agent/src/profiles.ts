/**
 * Model profiles (ADR-002, ADR-010): everything that differs per model lives here, so neither the loop
 * nor the Converse adapter branches on model names. `AGENT_MODEL_PROFILE` selects one; the model is
 * configuration, not code. The M3 eval matrix (#37) chooses the production default.
 *
 * Every model is called through Bedrock Converse. On-demand Claude and Nova calls need the `us.`
 * cross-region inference profile; gpt-oss is called by its in-region model ID. Request fields that
 * Converse doesn't model natively (reasoning switches) go in `modelFields`, which the adapter sends as
 * `additionalModelRequestFields`. Each value below was accepted live in spike S-1c.
 */
import type { TokenUsage } from "@sched/contracts";

export const MODEL_PROFILE_NAMES = [
  "sonnet-4.6",
  "haiku-4.5",
  "nova-2-lite",
  "nova-pro",
  "gpt-oss-120b",
  "gpt-oss-20b",
  "sonnet-5",
  "opus-5",
] as const;
export type ModelProfileName = (typeof MODEL_PROFILE_NAMES)[number];

/** The environment variable that selects the profile. */
export const MODEL_PROFILE_ENV = "AGENT_MODEL_PROFILE";

/** The development default (ADR-002 interim decision, kept by ADR-010). */
export const DEFAULT_MODEL_PROFILE: ModelProfileName = "sonnet-4.6";

/** USD per million tokens. On-demand list prices, used only for cost estimates in traces and evals. */
export interface ModelPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** When the price table was last checked against the Amazon Bedrock pricing page. */
export const PRICES_AS_OF = "2026-09-29";

export interface ModelProfile {
  /** Recorded in every trace as `modelProfile`. */
  readonly name: ModelProfileName;
  /** Bedrock model or inference-profile ID. */
  readonly modelId: string;
  /** Reasoning replay family: reasoning blocks go back only to a profile with the same family. */
  readonly family: "anthropic.claude" | "amazon.nova" | "openai.gpt-oss";
  /**
   * False while AWS blocks the model for this account ("not available for this account", ADR-002).
   * Resolving a profile that isn't entitled throws, so a misconfiguration fails fast instead of 403-ing
   * on the first patient message.
   */
  readonly entitled: boolean;
  /** Sent as Converse `additionalModelRequestFields` on every request (reasoning switches). */
  readonly modelFields: Readonly<Record<string, unknown>>;
  /** Whether this model accepts its own family's reasoning blocks back in history (Nova Pro rejects them). */
  readonly replaysReasoning: boolean;
  /** Tag the model writes chain-of-thought in, inside visible text (Nova Pro: `thinking`, gpt-oss: `reasoning`). */
  readonly inlineReasoningTag?: string;
  /**
   * Where the model accepts Converse cache points. A marker anywhere else is a ValidationException
   * (Nova: not in tools or after a tool result) or an AccessDenied (gpt-oss: no prompt caching).
   */
  readonly cachePoints: { readonly system: boolean; readonly messages: boolean };
  /**
   * Smallest prefix the model will cache, in tokens. Shorter prefixes silently don't cache (no error,
   * just zero cache tokens in the trace). 0 when the model has no explicit caching or no minimum was seen.
   */
  readonly minCacheableTokens: number;
  /** Output cap for a normal call. Reasoning tokens count against it. */
  readonly maxTokens: number;
  /** Output cap for the single retry after a `max_tokens` stop (ADR-001). */
  readonly retryMaxTokens: number;
  /** Profile for the single client-side retry after a refusal (Bedrock has no server-side fallbacks). */
  readonly fallback: ModelProfileName;
  readonly pricing: ModelPricing;
  /**
   * On-demand requests per minute this account gets for the model (from the account's Service Quotas,
   * as of 2026-09-29). The one source of truth: update it here. Live callers pace to it, e.g. the eval
   * harness's rate limiter.
   */
  readonly rpm: number;
}

/**
 * The refusal fallback for each profile. Claude follows the ADR-002 matrix (Opus 5 → Sonnet 5 →
 * Haiku 4.5, and the two callable Claude models back each other up); the others pair within their own
 * family so a fallback never changes vendor mid-turn. A switch costs a cold cache and drops reasoning
 * blocks the new model can't read, which is fine for a rare event. The eval matrix may revise this.
 */
export const REFUSAL_FALLBACKS: Readonly<Record<ModelProfileName, ModelProfileName>> = {
  "opus-5": "sonnet-5",
  "sonnet-5": "haiku-4.5",
  "sonnet-4.6": "haiku-4.5",
  "haiku-4.5": "sonnet-4.6",
  "nova-2-lite": "nova-pro",
  "nova-pro": "nova-2-lite",
  "gpt-oss-120b": "gpt-oss-20b",
  "gpt-oss-20b": "gpt-oss-120b",
};

const CLAUDE_ADAPTIVE = { thinking: { type: "adaptive" }, output_config: { effort: "medium" } } as const;
const CLAUDE_CACHE = { system: true, messages: true } as const;
const SYSTEM_CACHE_ONLY = { system: true, messages: false } as const;
const NO_CACHE = { system: false, messages: false } as const;

export const MODEL_PROFILES: Readonly<Record<ModelProfileName, ModelProfile>> = {
  /**
   * Development default. Sonnet 4.6 runs WITHOUT thinking unless adaptive thinking is set explicitly.
   * Spike S-1: 10/10 correct tool calls, full turn p50 5.16 s, and it caches our ~2.1k-token prefix.
   */
  "sonnet-4.6": {
    name: "sonnet-4.6",
    rpm: 10,
    modelId: "us.anthropic.claude-sonnet-4-6",
    family: "anthropic.claude",
    entitled: true,
    modelFields: CLAUDE_ADAPTIVE,
    replaysReasoning: true,
    cachePoints: CLAUDE_CACHE,
    minCacheableTokens: 1_024,
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["sonnet-4.6"],
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  /**
   * Fast and cheap Claude. Thinking off and no `effort` (Haiku 4.5 rejects it). Its 4,096-token cache
   * minimum is above our tools + system prefix (~2.6k tokens), so only a long conversation caches.
   */
  "haiku-4.5": {
    name: "haiku-4.5",
    rpm: 10,
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    family: "anthropic.claude",
    entitled: true,
    modelFields: {},
    replaysReasoning: true,
    cachePoints: CLAUDE_CACHE,
    minCacheableTokens: 4_096,
    maxTokens: 4_000,
    retryMaxTokens: 16_000,
    fallback: REFUSAL_FALLBACKS["haiku-4.5"],
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  /**
   * Amazon Nova 2 Lite with extended thinking at low effort. Its reasoning comes back as `[REDACTED]`
   * text (billed as output) and is accepted back in history. Cache points only in `system`.
   */
  "nova-2-lite": {
    name: "nova-2-lite",
    rpm: 20,
    modelId: "us.amazon.nova-2-lite-v1:0",
    family: "amazon.nova",
    entitled: true,
    modelFields: { reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } },
    replaysReasoning: true,
    cachePoints: SYSTEM_CACHE_ONLY,
    minCacheableTokens: 0,
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["nova-2-lite"],
    pricing: { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
  },
  /**
   * Amazon Nova Pro (v1). No reasoning switch; it writes `<thinking>…</thinking>` inline, usually before
   * tool calls and sometimes mid-reply (#107), which the adapter hides from the patient wherever it is. It rejects reasoning blocks in history.
   */
  "nova-pro": {
    name: "nova-pro",
    rpm: 25,
    modelId: "us.amazon.nova-pro-v1:0",
    family: "amazon.nova",
    entitled: true,
    modelFields: {},
    replaysReasoning: false,
    inlineReasoningTag: "thinking",
    cachePoints: SYSTEM_CACHE_ONLY,
    minCacheableTokens: 0,
    maxTokens: 4_000,
    retryMaxTokens: 10_000,
    fallback: REFUSAL_FALLBACKS["nova-pro"],
    pricing: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  },
  /**
   * OpenAI gpt-oss-120b (open weights), only through Bedrock (ADR-010). `reasoning_effort` is the chat
   * completions field, passed through Converse (Bedrock validates it). No prompt caching on Converse.
   * Besides its `reasoningContent` blocks, it sometimes writes `<reasoning>…</reasoning>` in visible text
   * (S-1c: 2 of 5 turns, at the start), which the adapter hides wherever it is.
   */
  "gpt-oss-120b": {
    name: "gpt-oss-120b",
    rpm: 100,
    modelId: "openai.gpt-oss-120b-1:0",
    family: "openai.gpt-oss",
    entitled: true,
    modelFields: { reasoning_effort: "low" },
    replaysReasoning: true,
    inlineReasoningTag: "reasoning",
    cachePoints: NO_CACHE,
    minCacheableTokens: 0,
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["gpt-oss-120b"],
    pricing: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
  },
  /** OpenAI gpt-oss-20b: the smallest and cheapest profile. Same settings as gpt-oss-120b. */
  "gpt-oss-20b": {
    name: "gpt-oss-20b",
    rpm: 100,
    modelId: "openai.gpt-oss-20b-1:0",
    family: "openai.gpt-oss",
    entitled: true,
    modelFields: { reasoning_effort: "low" },
    replaysReasoning: true,
    inlineReasoningTag: "reasoning",
    cachePoints: NO_CACHE,
    minCacheableTokens: 0,
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["gpt-oss-20b"],
    pricing: { input: 0.07, output: 0.3, cacheRead: 0, cacheWrite: 0 },
  },
  /**
   * Target model. NOT ENTITLED on this account (AWS denied access; ADR-002, ADR-010). Defined so the
   * switch is one flag. Adaptive thinking is on by default on Sonnet 5; it's set explicitly anyway.
   */
  "sonnet-5": {
    name: "sonnet-5",
    rpm: 10,
    modelId: "us.anthropic.claude-sonnet-5",
    family: "anthropic.claude",
    entitled: false,
    modelFields: CLAUDE_ADAPTIVE,
    replaysReasoning: true,
    cachePoints: CLAUDE_CACHE,
    minCacheableTokens: 1_024,
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["sonnet-5"],
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  /**
   * Target model. NOT ENTITLED on this account (see sonnet-5). Never disable thinking on Opus 5
   * (disabled thinking can leak tool calls into visible text); tune `effort` instead.
   */
  "opus-5": {
    name: "opus-5",
    rpm: 10,
    modelId: "us.anthropic.claude-opus-5",
    family: "anthropic.claude",
    entitled: false,
    modelFields: CLAUDE_ADAPTIVE,
    replaysReasoning: true,
    cachePoints: CLAUDE_CACHE,
    minCacheableTokens: 512,
    maxTokens: 8_000,
    retryMaxTokens: 32_000,
    fallback: REFUSAL_FALLBACKS["opus-5"],
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
};

export function isModelProfileName(value: string): value is ModelProfileName {
  return (MODEL_PROFILE_NAMES as readonly string[]).includes(value);
}

/**
 * The profile with this name, or the default when the name is empty or missing. Throws on an unknown
 * name, and on a profile this account isn't entitled to call.
 */
export function resolveModelProfile(name: string | undefined): ModelProfile {
  const key = name?.trim() || DEFAULT_MODEL_PROFILE;
  if (!isModelProfileName(key)) {
    throw new Error(
      `Unknown ${MODEL_PROFILE_ENV} "${key}". Expected one of: ${MODEL_PROFILE_NAMES.join(", ")}.`,
    );
  }
  const profile = MODEL_PROFILES[key];
  if (!profile.entitled) {
    throw new Error(
      `${MODEL_PROFILE_ENV} "${key}" (${profile.modelId}) is not entitled on this AWS account yet (ADR-010).`,
    );
  }
  return profile;
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

/** Estimated cost of `usage` on `profile`, in USD (list prices; see `PRICES_AS_OF`). */
export function estimateCostUsd(profile: ModelProfile, usage: TokenUsage): number {
  const p = profile.pricing;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
