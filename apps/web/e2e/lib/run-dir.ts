/**
 * The run directory's list of the conversations a run started (#40, r1/A-8): `support/chat.ts` records each turn's
 * conversation, and `cost-reporter.ts` reads the list back to sum their traces. `global-setup.ts` creates the
 * directory outside the checkout and passes it to the workers as `E2E_RUN_DIR`. One file, one line per recorded turn.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONVERSATIONS_FILE = "conversations.txt";

/** Appends `conversationId` to the run's list. Writes nothing without a directory (no run) or without an ID. */
export function recordConversation(dir: string | undefined, conversationId: string | undefined): void {
  if (!dir || !conversationId) return;
  appendFileSync(join(dir, CONVERSATIONS_FILE), `${conversationId}\n`);
}

/**
 * The conversations recorded in `dir`, each once, in the order first recorded. A turn records its conversation, so a
 * three-turn booking lists it three times; reading its traces three times would triple the estimate.
 */
export function recordedConversations(dir: string): string[] {
  const file = join(dir, CONVERSATIONS_FILE);
  if (!existsSync(file)) return [];
  return [...new Set(readFileSync(file, "utf8").split("\n").filter(Boolean))];
}
