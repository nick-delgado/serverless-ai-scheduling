/**
 * Which `Transcriber` the mic uses (S6-01 #28, S6-02 #29). Like `ChatApiContext`, a context with a
 * default, so the chat page passes nothing and tests provide their own. `defaultTranscriber` is the
 * real-or-mock factory (#29 r1/Q-2 (a), r1/A-3):
 *
 * - A build with the Identity Pool ID (`VITE_IDENTITY_POOL_ID` beside the pool and client IDs; every
 *   deployed build, `scripts/deploy-web.sh`): the `RealTranscriber`, streaming to Amazon Transcribe.
 * - The dev server without it (on the Cognito mock, whose tokens can't get AWS credentials): a
 *   `MockTranscriber` that "hears" a sample sentence about a second after Send.
 * - Any other build without it: none. The mic shows disabled with a one-line note (`NO_VOICE`).
 *
 * Nothing here touches browser audio APIs, fetches credentials or loads the Transcribe SDK; the
 * `RealTranscriber` does all of that in `start()` (r2/A-3). So rendering `<ChatPage>` in jsdom needs
 * no stubs, and the SDK stays out of the entry chunk. The `import.meta.env.DEV` branch is dropped from
 * production builds, and the mock with it.
 */
import { createContext } from "react";

import { getAwsCredentials, resolveIdentityPoolId } from "../auth";
import { MockTranscriber } from "./MockTranscriber";
import { identityPoolRegion, RealTranscriber } from "./transcribe/RealTranscriber";
import type { Transcriber } from "./transcriber";
import { observeTiming } from "./voiceTiming";

/** The dev server's mock: a short "permission prompt", then the sample transcript 1 s after Send. */
export const DEV_MOCK_OPTIONS = { startDelayMs: 300, delayMs: 1000 } as const;

export function defaultTranscriber(): Transcriber | null {
  const identityPoolId = resolveIdentityPoolId(import.meta.env);
  if (identityPoolId) {
    return new RealTranscriber({
      region: identityPoolRegion(identityPoolId),
      getCredentials: getAwsCredentials,
      ...(observeTiming ? { observe: observeTiming } : {}),
    });
  }
  return import.meta.env.DEV ? new MockTranscriber({ ...DEV_MOCK_OPTIONS }) : null;
}

/** The mic's Transcriber; null shows the mic disabled. */
export const TranscriberContext = createContext<Transcriber | null>(defaultTranscriber());
