import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL_PROFILE,
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
    expect(resolveModelProfile(" opus-5 ").name).toBe("opus-5");
  });

  it("rejects an unknown profile name, listing the valid ones", () => {
    expect(() => modelProfileFromEnv({ AGENT_MODEL_PROFILE: "gpt-5" })).toThrow(/sonnet-4\.6, haiku-4\.5/);
  });

  it("uses US inference-profile IDs on bedrock-runtime", () => {
    expect(Object.fromEntries(MODEL_PROFILE_NAMES.map((n) => [n, MODEL_PROFILES[n].modelId]))).toEqual({
      "sonnet-4.6": "us.anthropic.claude-sonnet-4-6",
      "haiku-4.5": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "sonnet-5": "us.anthropic.claude-sonnet-5",
      "opus-5": "us.anthropic.claude-opus-5",
    });
  });

  it("sets Sonnet 4.6's adaptive thinking explicitly (it runs without thinking otherwise) at medium effort", () => {
    expect(MODEL_PROFILES["sonnet-4.6"].params).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  it("sends Haiku 4.5 no effort (it errors) and no thinking", () => {
    expect(MODEL_PROFILES["haiku-4.5"].params).toEqual({});
    expect(MODEL_PROFILES["haiku-4.5"].minCacheableTokens).toBe(4_096);
  });

  it("never disables thinking and never sends sampling params", () => {
    for (const name of MODEL_PROFILE_NAMES) {
      const params: Record<string, unknown> = { ...MODEL_PROFILES[name].params };
      expect(params.thinking).not.toEqual({ type: "disabled" });
      expect(Object.keys(params)).not.toContain("temperature");
      expect(Object.keys(params)).not.toContain("top_p");
      expect(Object.keys(params)).not.toContain("top_k");
    }
    expect(MODEL_PROFILES["opus-5"].params.thinking).toEqual({ type: "adaptive" });
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
    }
    // The two models this account can call today back each other up.
    expect(fallbackProfileFor(MODEL_PROFILES["sonnet-4.6"]).name).toBe("haiku-4.5");
    expect(fallbackProfileFor(MODEL_PROFILES["haiku-4.5"]).name).toBe("sonnet-4.6");
  });
});
