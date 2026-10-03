/**
 * Versioned system prompts (#16). `buildSystemPrompt` is the current version, so callers (the chat
 * handler, #36; the eval harness) pick up a new version without code changes. Each prompt's `version`
 * is recorded in every turn trace as `promptVersion`.
 */
import { systemPromptV1 } from "./system.v1";

export {
  ESCALATION_MESSAGE,
  SYSTEM_PROMPT_V1_VERSION,
  renderSystemPromptV1Dynamic,
  systemPromptV1,
  type SystemPromptContext,
} from "./system.v1";

/** The current system prompt (v1). */
export const buildSystemPrompt = systemPromptV1;
