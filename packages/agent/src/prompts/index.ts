/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`.
 */
import { systemPromptV2 } from "./system.v2";

export {
  ESCALATION_MESSAGE,
  SYSTEM_PROMPT_V2_VERSION,
  renderSystemPromptV2Dynamic,
  systemPromptV2,
  type SystemPromptContext,
} from "./system.v2";

/** The current system prompt (v2, #230). */
export const buildSystemPrompt = systemPromptV2;
