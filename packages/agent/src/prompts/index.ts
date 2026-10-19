/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`. A version bump changes only files in this
 * directory: the one literal pin of the version is in `system.vN.test.ts`, and tests elsewhere compare
 * against `buildSystemPrompt(...).version` (#299).
 */
import { systemPromptV14 } from "./system.v14";

export type { SystemPromptContext } from "./system.v14";

/** The current system prompt (v14, #251, on #234's v13). */
export const buildSystemPrompt = systemPromptV14;
