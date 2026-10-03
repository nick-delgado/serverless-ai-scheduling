/**
 * The mock API for Vitest (installed by src/test/setup.ts). Tests start with no delays and no
 * faults; change that per test with `configureMockApi`, which resets after each test.
 *
 *   configureMockApi({ chatFault: "mid_stream" });
 *   configureMockApi({ firstEventMs: 50 }); // with vi.useFakeTimers() if you don't want to wait
 */
import { setupServer } from "msw/node";

import { createMockApi } from "./handlers";
import { INSTANT_MOCK_API_OPTIONS, type MockApiOptions } from "./options";

let current: MockApiOptions = INSTANT_MOCK_API_OPTIONS;
const api = createMockApi(() => current);

export const server = setupServer(...api.handlers);

export function configureMockApi(changes: Partial<MockApiOptions>): void {
  current = { ...current, ...changes };
}

export function resetMockApi(): void {
  current = INSTANT_MOCK_API_OPTIONS;
  api.reset();
}
