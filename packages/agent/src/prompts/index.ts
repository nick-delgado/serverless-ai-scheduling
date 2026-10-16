/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`.
 */
import { systemPromptV5 } from "./system.v5";

export {
  ESCALATION_MESSAGE,
  SYSTEM_PROMPT_V5_VERSION,
  renderSystemPromptV5Dynamic,
  systemPromptV5,
  type SystemPromptContext,
} from "./system.v5";

/** The current system prompt (v5, #249 with #250). */
export const buildSystemPrompt = systemPromptV5;
