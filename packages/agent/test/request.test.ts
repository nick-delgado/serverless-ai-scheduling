import { describe, expect, it } from "vitest";

import { CACHE_POINT, MODEL_PROFILES, profileRequest, type ModelProfile } from "../src";

/** A profile whose every field differs from the others, so a swapped or dropped field shows. */
const profile: ModelProfile = {
  ...MODEL_PROFILES["nova-pro"],
  modelId: "test.model-id",
  family: "amazon.nova",
  maxTokens: 1111,
  modelFields: { reasoningConfig: { type: "enabled" } },
  inlineReasoningTag: "think-tag",
  cachePoints: { system: true, messages: false },
};

describe("profileRequest (#105)", () => {
  it("copies each profile field into the request, and nothing else", () => {
    expect(profileRequest(profile, { stable: "S" })).toEqual({
      modelId: "test.model-id",
      family: "amazon.nova",
      system: [{ type: "text", text: "S" }, CACHE_POINT],
      maxTokens: 1111,
      modelFields: { reasoningConfig: { type: "enabled" } },
      inlineReasoningTag: "think-tag",
    });
  });

  it("leaves the inline reasoning tag's key out when the profile has none", () => {
    const { inlineReasoningTag: _omitted, ...withoutTag } = profile;
    expect(Object.keys(profileRequest(withoutTag, { stable: "S" }))).not.toContain("inlineReasoningTag");
  });

  it("uses the caller's maxTokens when given one", () => {
    expect(profileRequest(profile, { stable: "S" }, { maxTokens: 2222 }).maxTokens).toBe(2222);
  });

  it("puts one cache point after the stable text exactly when profile.cachePoints.system is set", () => {
    const system = { stable: "stable", dynamic: "dynamic" };
    expect(profileRequest(profile, system).system).toEqual([
      { type: "text", text: "stable" },
      CACHE_POINT,
      { type: "text", text: "dynamic" },
    ]);
    const noSystemCache = { ...profile, cachePoints: { system: false, messages: true } };
    expect(profileRequest(noSystemCache, system).system).toEqual([
      { type: "text", text: "stable" },
      { type: "text", text: "dynamic" },
    ]);
  });

  it("sends no dynamic block when the dynamic text is missing or empty", () => {
    expect(profileRequest(profile, { stable: "S", dynamic: "" }).system).toEqual([
      { type: "text", text: "S" },
      CACHE_POINT,
    ]);
  });
});
