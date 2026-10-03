/**
 * The mock API in the browser (dev server only; see main.tsx). Options live in local storage under
 * `sched.mockApi` and are read on every request. From the devtools console:
 *
 *   schedMock.set({ chatFault: "mid_stream" })   // or firstEventMs: 4000, chatReply: "reset", session: "restore", ...
 *   schedMock.options()                          // the options in effect
 *   schedMock.reset()                            // back to the defaults
 */
import { setupWorker } from "msw/browser";

import { createMockApiControls, type MockApiControls, readMockApiOptions } from "./controls";
import { createMockApi } from "./handlers";

declare global {
  interface Window {
    schedMock?: MockApiControls;
  }
}

export async function startMockWorker(): Promise<void> {
  const api = createMockApi(readMockApiOptions);
  window.schedMock = createMockApiControls(api.reset);
  await setupWorker(...api.handlers).start({ onUnhandledFrame: "bypass" });
  console.info("Mock API on. Configure it with schedMock.set({...}); see src/mocks/browser.ts.");
}
