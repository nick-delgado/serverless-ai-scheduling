/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`. A version bump changes only files in this
 * directory: the one literal pin of the version is in `system.vN.test.ts`, and tests elsewhere compare
 * against `buildSystemPrompt(...).version` (#299).
 */
import { systemPromptV12 } from "./system.v12";

export type { SystemPromptContext } from "./system.v12";

/** The current system prompt (v12, #332, on #326's v11). */
export const buildSystemPrompt = systemPromptV12;
