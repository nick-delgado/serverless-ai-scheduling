/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`.
 */
import { systemPromptV3 } from "./system.v3";

export {
  ESCALATION_MESSAGE,
  SYSTEM_PROMPT_V3_VERSION,
  renderSystemPromptV3Dynamic,
  systemPromptV3,
  type SystemPromptContext,
} from "./system.v3";

/** The current system prompt (v3, #233). */
export const buildSystemPrompt = systemPromptV3;
