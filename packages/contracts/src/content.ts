/**
 * Provider-neutral conversation content (contracts v1.1, ADR-010). These are the blocks stored in
 * `ConversationMessage.content` and exchanged with every model through the `LlmClient` seam. The
 * Converse adapter in `packages/agent` maps them to and from Bedrock's wire shapes; nothing here is
 * specific to one provider.
 *
 * Blocks tolerate unknown keys (forward compatibility, and stored rows must keep parsing), but every
 * field listed is required and typed. History is replayed unchanged (CLAUDE.md rule 4).
 */
import { z } from "zod";

/** Visible text from the patient or the assistant. */
export const TextBlock = z.looseObject({
  type: z.literal("text"),
  text: z.string().min(1),
});
export type TextBlock = z.infer<typeof TextBlock>;

/** A tool call from the model. `input` is untrusted: the executor validates it against the tool schema. */
export const ToolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1).max(200),
  /** As the model wrote it; it may name a tool that was never offered. */
  name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlock>;

/** The answer to one `tool_use`, sent back in a user message. `content` is the JSON-encoded tool output or `ToolError`. */
export const ToolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  toolUseId: z.string().min(1).max(200),
  content: z.string(),
  isError: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlock>;

/**
 * A model's reasoning, stored opaquely. Nothing reads it: it exists so it can be passed back unchanged
 * to a model of the same `family` (Claude validates `signature` on the way back), and it's dropped
 * before any request to another family, or to a model that doesn't accept reasoning input.
 */
export const ReasoningBlock = z.looseObject({
  type: z.literal("reasoning"),
  /** Replay tag, e.g. `anthropic.claude`, `amazon.nova`, `openai.gpt-oss` (the model profile's `family`). */
  family: z.string().min(1).max(64),
  /** The model that produced it (diagnostics only). */
  modelId: z.string().min(1).max(200),
  /** Reasoning text as returned. May be a summary, `[REDACTED]`, or empty. */
  text: z.string().optional(),
  /** Provider signature that authenticates `text` on replay (Claude). */
  signature: z.string().optional(),
  /** Encrypted reasoning, base64 (Claude's redacted thinking). */
  redactedContent: z.string().optional(),
});
export type ReasoningBlock = z.infer<typeof ReasoningBlock>;

/** Any stored content block. */
export const ContentBlock = z.discriminatedUnion("type", [
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ReasoningBlock,
]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export type ContentBlockType = ContentBlock["type"];
