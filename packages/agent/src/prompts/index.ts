/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`.
 */
import { systemPromptV4 } from "./system.v4";

export {
  ESCALATION_MESSAGE,
  SYSTEM_PROMPT_V4_VERSION,
  renderSystemPromptV4Dynamic,
  systemPromptV4,
  type SystemPromptContext,
} from "./system.v4";

/** The current system prompt (v4, #236). */
export const buildSystemPrompt = systemPromptV4;
