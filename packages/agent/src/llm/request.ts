/**
 * The profile-derived part of an `LlmRequest` (#105): everything but `tools` and `messages`. The agent
 * loop, L1 (`l1Request`), the patient simulator and the judge all build their requests with it, so a
 * field a profile gains reaches every caller, and every caller places the system cache point the same way.
 *
 * - `modelId`, `family` and `modelFields` come from the profile; `inlineReasoningTag` too, and the key is
 *   left out when the profile has none.
 * - `maxTokens` is the profile's, unless the caller overrides it (the loop does, for its `max_tokens`
 *   retry).
 * - `system`: the stable text, then one cache point when `profile.cachePoints.system` is set, then the
 *   dynamic text if there is any. Tools render before system, so the cache point caches tools + stable
 *   system together, and the volatile part comes after it (ADR-001 "Caching", ADR-010).
 *
 * The rolling message cache point is not here: it belongs to the loop's message copy (`requestMessages`).
 */
import type { ModelProfile } from "../profiles";
import { CACHE_POINT, type CachePoint, type LlmRequest, type LlmSystemText } from "./types";

/** System text split for caching: `stable` is byte-identical on every request, `dynamic` changes. */
export interface RequestSystem {
  stable: string;
  dynamic?: string;
}

/** An `LlmRequest` without the caller's `tools` and `messages`. */
export type ProfileRequest = Omit<LlmRequest, "tools" | "messages">;

export function profileRequest(
  profile: ModelProfile,
  system: RequestSystem,
  options: { maxTokens?: number } = {},
): ProfileRequest {
  const blocks: (LlmSystemText | CachePoint)[] = [{ type: "text", text: system.stable }];
  if (profile.cachePoints.system) blocks.push(CACHE_POINT);
  if (system.dynamic) blocks.push({ type: "text", text: system.dynamic });
  return {
    modelId: profile.modelId,
    family: profile.family,
    system: blocks,
    maxTokens: options.maxTokens ?? profile.maxTokens,
    modelFields: profile.modelFields,
    ...(profile.inlineReasoningTag === undefined ? {} : { inlineReasoningTag: profile.inlineReasoningTag }),
  };
}
