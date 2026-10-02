/**
 * The mock API in the browser (dev server only; see main.tsx). Options live in local storage under
 * `sched.mockApi` and are read on every request. From the devtools console:
 *
 *   schedMock.set({ chatFault: "mid_stream" })   // or firstEventMs: 4000, chatReply: "reset", session: "restore", ...
 *   schedMock.options()                          // the options in effect
 *   schedMock.reset()                            // back to the defaults
 */
import { setupWorker } from "msw/browser";

import { createMockApi } from "./handlers";
import { DEFAULT_MOCK_API_OPTIONS, type MockApiOptions, parseMockApiOptions } from "./options";

const STORAGE_KEY = "sched.mockApi";

function readOptions(): MockApiOptions {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? parseMockApiOptions(JSON.parse(stored)) : DEFAULT_MOCK_API_OPTIONS;
  } catch {
    return DEFAULT_MOCK_API_OPTIONS;
  }
}

function writeOptions(options: MockApiOptions | null): void {
  try {
    if (options) localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window): options stay at their defaults.
  }
}

export interface MockApiControls {
  options: () => MockApiOptions;
  set: (changes: Partial<MockApiOptions>) => MockApiOptions;
  reset: () => MockApiOptions;
}

declare global {
  interface Window {
    schedMock?: MockApiControls;
  }
}

export async function startMockWorker(): Promise<void> {
  const api = createMockApi(readOptions);
  window.schedMock = {
    options: readOptions,
    set: (changes) => {
      const options = parseMockApiOptions({ ...readOptions(), ...changes });
      writeOptions(options);
      return options;
    },
    reset: () => {
      writeOptions(null);
      api.reset();
      return DEFAULT_MOCK_API_OPTIONS;
    },
  };
  await setupWorker(...api.handlers).start({ onUnhandledFrame: "bypass" });
  console.info("Mock API on. Configure it with schedMock.set({...}); see src/mocks/browser.ts.");
}
