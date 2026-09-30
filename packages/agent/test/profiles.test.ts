import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PROFILE,
  estimateCostUsd,
  fallbackProfileFor,
  MODEL_PROFILE_NAMES,
  MODEL_PROFILES,
  modelProfileFromEnv,
  REFUSAL_FALLBACKS,
  resolveModelProfile,
} from "../src";

describe("model profiles", () => {
  it("selects the profile named by AGENT_MODEL_PROFILE, defaulting to Sonnet 4.6", () => {
    expect(DEFAULT_MODEL_PROFILE).toBe("sonnet-4.6");
    expect(modelProfileFromEnv({}).name).toBe("sonnet-4.6");
    expect(modelProfileFromEnv({ AGENT_MODEL_PROFILE: "" }).name).toBe("sonnet-4.6");
    expect(modelProfileFromEnv({ AGENT_MODEL_PROFILE: "haiku-4.5" }).name).toBe("haiku-4.5");
    expect(resolveModelProfile(" nova-2-lite ").name).toBe("nova-2-lite");
  });

  it("rejects an unknown profile name, listing the valid ones", () => {
    expect(() => modelProfileFromEnv({ AGENT_MODEL_PROFILE: "gpt-5" })).toThrow(/sonnet-4\.6, haiku-4\.5/);
  });

  it("keeps Opus 5 and Sonnet 5 defined but refuses to resolve them until they're entitled", () => {
    expect(MODEL_PROFILES["opus-5"].entitled).toBe(false);
    expect(MODEL_PROFILES["sonnet-5"].entitled).toBe(false);
    expect(() => resolveModelProfile("opus-5")).toThrow(/not entitled/);
    expect(() => resolveModelProfile("sonnet-5")).toThrow(/not entitled/);
    const entitled = MODEL_PROFILE_NAMES.filter((n) => MODEL_PROFILES[n].entitled);
    expect(entitled).toEqual([
      "sonnet-4.6",
      "haiku-4.5",
      "nova-2-lite",
      "nova-pro",
      "gpt-oss-120b",
      "gpt-oss-20b",
    ]);
  });

  it("uses the Bedrock IDs verified through Converse", () => {
    expect(Object.fromEntries(MODEL_PROFILE_NAMES.map((n) => [n, MODEL_PROFILES[n].modelId]))).toEqual({
      "sonnet-4.6": "us.anthropic.claude-sonnet-4-6",
      "haiku-4.5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "nova-2-lite": "us.amazon.nova-2-lite-v1:0",
      "nova-pro": "us.amazon.nova-pro-v1:0",
      "gpt-oss-120b": "openai.gpt-oss-120b-1:0",
      "gpt-oss-20b": "openai.gpt-oss-20b-1:0",
      "sonnet-5": "us.anthropic.claude-sonnet-5",
      "opus-5": "us.anthropic.claude-opus-5",
    });
    for (const name of MODEL_PROFILE_NAMES) expect(MODEL_PROFILES[name].name).toBe(name);
  });

  it("sets each model's reasoning switch in modelFields", () => {
    expect(MODEL_PROFILES["sonnet-4.6"].modelFields).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    expect(MODEL_PROFILES["haiku-4.5"].modelFields).toEqual({}); // Haiku 4.5 rejects effort
    expect(MODEL_PROFILES["nova-2-lite"].modelFields).toEqual({
      reasoningConfig: { type: "enabled", maxReasoningEffort: "low" },
    });
    expect(MODEL_PROFILES["gpt-oss-120b"].modelFields).toEqual({ reasoning_effort: "low" });
  });

  it("never disables Claude thinking and never sends sampling params", () => {
    for (const name of MODEL_PROFILE_NAMES) {
      const fields: Record<string, unknown> = { ...MODEL_PROFILES[name].modelFields };
      expect(fields.thinking).not.toEqual({ type: "disabled" });
      for (const key of ["temperature", "top_p", "top_k", "topP", "topK"])
        expect(Object.keys(fields)).not.toContain(key);
    }
    expect(MODEL_PROFILES["opus-5"].modelFields.thinking).toEqual({ type: "adaptive" });
  });

  it("declares cache points only where each model accepts them", () => {
    const where = (n: (typeof MODEL_PROFILE_NAMES)[number]) => MODEL_PROFILES[n].cachePoints;
    expect(where("sonnet-4.6")).toEqual({ system: true, messages: true });
    expect(where("nova-pro")).toEqual({ system: true, messages: false });
    expect(where("gpt-oss-20b")).toEqual({ system: false, messages: false });
    expect(MODEL_PROFILES["haiku-4.5"].minCacheableTokens).toBe(4_096);
  });

  it("hides inline chain-of-thought (Nova Pro, gpt-oss) and never replays reasoning to Nova Pro", () => {
    expect(MODEL_PROFILES["nova-pro"]).toMatchObject({
      inlineReasoningTag: "thinking",
      replaysReasoning: false,
    });
    expect(MODEL_PROFILES["nova-2-lite"].replaysReasoning).toBe(true);
    expect(MODEL_PROFILES["gpt-oss-120b"].inlineReasoningTag).toBe("reasoning");
    expect(MODEL_PROFILES["gpt-oss-20b"].inlineReasoningTag).toBe("reasoning");
  });

  it("retries max_tokens with a larger budget", () => {
    for (const name of MODEL_PROFILE_NAMES) {
      const { maxTokens, retryMaxTokens } = MODEL_PROFILES[name];
      expect(retryMaxTokens).toBeGreaterThan(maxTokens);
    }
  });

  it("maps every profile to a different fallback profile for refusals", () => {
    for (const name of MODEL_PROFILE_NAMES) {
      const profile = MODEL_PROFILES[name];
      expect(profile.fallback).toBe(REFUSAL_FALLBACKS[name]);
      expect(fallbackProfileFor(profile).name).not.toBe(name);
      if (profile.entitled) expect(fallbackProfileFor(profile).entitled).toBe(true);
    }
    expect(fallbackProfileFor(MODEL_PROFILES["sonnet-4.6"]).name).toBe("haiku-4.5");
    expect(fallbackProfileFor(MODEL_PROFILES["haiku-4.5"]).name).toBe("sonnet-4.6");
  });

  it("estimates cost from the price table", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
    };
    expect(estimateCostUsd(MODEL_PROFILES["sonnet-4.6"], usage)).toBeCloseTo(3 + 1.5 + 0.3);
    for (const name of MODEL_PROFILE_NAMES) expect(MODEL_PROFILES[name].pricing.output).toBeGreaterThan(0);
  });
});
