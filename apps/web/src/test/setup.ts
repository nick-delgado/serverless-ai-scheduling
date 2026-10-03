/** Vitest setup for @sched/web: jest-dom matchers, DOM cleanup, and the MSW mock API on every test. */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetMockApi, server } from "../mocks/node";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockApi();
});
afterAll(() => server.close());
