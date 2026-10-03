/**
 * The dev-console `schedMock` controls and their local-storage round trip. Kept apart from
 * `browser.ts` (which pulls in `msw/browser`) so they can be tested under jsdom.
 */
import { DEFAULT_MOCK_API_OPTIONS, type MockApiOptions, parseMockApiOptions } from "./options";

export const MOCK_API_STORAGE_KEY = "sched.mockApi";

/** The options in effect: the stored ones, with defaults for anything missing or unreadable. */
export function readMockApiOptions(): MockApiOptions {
  try {
    const stored = localStorage.getItem(MOCK_API_STORAGE_KEY);
    return stored ? parseMockApiOptions(JSON.parse(stored)) : DEFAULT_MOCK_API_OPTIONS;
  } catch {
    return DEFAULT_MOCK_API_OPTIONS;
  }
}

function writeOptions(options: MockApiOptions | null): void {
  try {
    if (options) localStorage.setItem(MOCK_API_STORAGE_KEY, JSON.stringify(options));
    else localStorage.removeItem(MOCK_API_STORAGE_KEY);
  } catch {
    // Storage blocked (private window): options stay at their defaults.
  }
}

export interface MockApiControls {
  options: () => MockApiOptions;
  set: (changes: Partial<MockApiOptions>) => MockApiOptions;
  reset: () => MockApiOptions;
}

/** `resetApi` forgets the conversations the mock has seen (`MockApi.reset`). */
export function createMockApiControls(resetApi: () => void): MockApiControls {
  return {
    options: readMockApiOptions,
    set: (changes) => {
      const options = parseMockApiOptions({ ...readMockApiOptions(), ...changes });
      writeOptions(options);
      return options;
    },
    reset: () => {
      writeOptions(null);
      resetApi();
      return DEFAULT_MOCK_API_OPTIONS;
    },
  };
}
