/**
 * How a patient's message is rendered into what the model sees (#234). One pure function serves every
 * caller (the agent loop for the new message, the API's `toLlmHistory` for stored messages, the eval L1
 * builder), so a spoken message reads byte for byte the same in the turn that sent it and in every
 * later turn: the cache point and the earlier history stay stable (CLAUDE.md rule 4, ADR-007).
 *
 * The marker is a fixed literal chosen by the mode, never built from client text. The mode is
 * client-supplied and untrusted (ADR-009): it can only add care, so a typed message that contains the
 * marker's words, or claims it was typed, is passed through unchanged and relaxes no rule (the prompt
 * says so).
 */
import type { ChatInputMode } from "@sched/contracts";

import type { ContentBlock, TextBlock } from "./llm/types";

/** How a message was entered. Absent means typed. */
export type InputMode = ChatInputMode;

/** The line a spoken patient message carries before the patient's own words. */
export const SPOKEN_MESSAGE_MARKER =
  "[Spoken message: transcribed from voice, so names, dates, times and providers may be misheard.]";

const MARKER_BLOCK: Readonly<TextBlock> = { type: "text", text: SPOKEN_MESSAGE_MARKER };

/**
 * A patient message's content as the model sees it: a spoken one is the marker block followed by the
 * patient's blocks; a typed one (or none) is the patient's blocks alone, as before #234.
 */
export function withInputMode(content: readonly ContentBlock[], inputMode?: InputMode): ContentBlock[] {
  return inputMode === "voice" ? [{ ...MARKER_BLOCK }, ...content] : [...content];
}

/** The patient's own blocks of a rendered message: drops the marker `withInputMode` put in front. */
export function withoutInputMarker(content: readonly ContentBlock[]): ContentBlock[] {
  const [first, ...rest] = content;
  return first?.type === "text" && first.text === SPOKEN_MESSAGE_MARKER && rest.length > 0
    ? rest
    : [...content];
}
