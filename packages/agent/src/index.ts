/**
 * @sched/agent: the agent loop (`runAgentTurn`), the `LlmClient` seam with its Bedrock implementation
 * and a scripted fake, and the model profiles (S3-01, #15). The system prompt lives in `prompts/` (#16).
 */
export {
  DEFAULT_LIMITS,
  TEXT_BLOCK_SEPARATOR,
  runAgentTurn,
  type AgentLimits,
  type AgentTurnResult,
  type RunAgentTurnInput,
  type SystemPrompt,
} from "./loop";
export { systemClock, type Clock, type ToolCall, type ToolExecutionResult, type ToolExecutor } from "./ports";
export {
  DEFAULT_MODEL_PROFILE,
  MODEL_PROFILES,
  MODEL_PROFILE_ENV,
  MODEL_PROFILE_NAMES,
  REFUSAL_FALLBACKS,
  fallbackProfileFor,
  isModelProfileName,
  modelProfileFromEnv,
  resolveModelProfile,
  type ModelProfile,
  type ModelProfileName,
} from "./profiles";
export { FALLBACK_MESSAGES } from "./fallback-messages";
export type { LlmCallOptions, LlmClient, LlmRequest, LlmStreamHandlers } from "./llm/client";
export { BedrockLlmClient, type BedrockLlmClientOptions } from "./llm/bedrock";
export {
  ScriptedLlmClient,
  scriptedMaxTokens,
  scriptedRefusal,
  scriptedText,
  scriptedToolUse,
  type ScriptedLlmClientOptions,
  type ScriptedResponse,
  type ScriptedStep,
  type ScriptedToolUse,
} from "./llm/scripted";
