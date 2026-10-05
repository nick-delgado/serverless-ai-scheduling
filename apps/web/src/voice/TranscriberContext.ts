/**
 * Which `Transcriber` the mic uses (S6-01, #28). Like `ChatApiContext`, a context with a default, so
 * the chat page passes nothing and tests provide their own.
 *
 * - Dev server: a `MockTranscriber` that "hears" a sample sentence about a second after Send, in place
 *   of the browser's mic prompt until #29.
 * - Production builds: none yet. The mic shows disabled with a one-line note, #29's missing-config
 *   state. #29 replaces `defaultTranscriber` with its real-or-mock factory, inside `src/voice/`.
 *
 * Nothing here touches browser audio APIs, so rendering `<ChatPage>` in jsdom needs no stubs. The
 * `import.meta.env.DEV` branch is dropped from production builds, and the mock with it.
 */
import { createContext } from "react";

import { MockTranscriber } from "./MockTranscriber";
import type { Transcriber } from "./transcriber";

/** The dev server's mock: a short "permission prompt", then the sample transcript 1 s after Send. */
export const DEV_MOCK_OPTIONS = { startDelayMs: 300, delayMs: 1000 } as const;

export function defaultTranscriber(): Transcriber | null {
  return import.meta.env.DEV ? new MockTranscriber({ ...DEV_MOCK_OPTIONS }) : null;
}

/** The mic's Transcriber; null shows the mic disabled. */
export const TranscriberContext = createContext<Transcriber | null>(defaultTranscriber());
