/**
 * Vitest setup for @sched/web: jest-dom matchers, DOM cleanup, and the MSW mock API (with the
 * Cognito mock) on every test, reset after each one.
 */
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetCognitoMock } from "../mocks/cognito";
import { resetMockApi, server } from "../mocks/node";

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockApi();
  resetCognitoMock();
});
afterAll(() => server.close());
