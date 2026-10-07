/**
 * Vitest setup for @sched/web: jest-dom matchers, DOM cleanup, and the MSW mock API (with the
 * Cognito mock) on every test, reset after each one. `fetch` gets a connection of its own for each
 * request (`connectionPerRequest`, src/mocks/node.ts; #206).
 */
import "@testing-library/jest-dom/vitest";

import { cleanup, configure } from "@testing-library/react";
import { setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll } from "vitest";

import { resetCognitoMock } from "../mocks/cognito";
import { connectionPerRequest, resetMockApi, server } from "../mocks/node";

// findBy*/waitFor give up after 3 s, not the default 1 s. CI runs this suite under v8 coverage (#140), which
// makes the Cognito mock's SRP sign-in about 3x slower; on a GitHub runner a sign-in then passed the 1 s mark
// and LoginPage tests failed while waiting for the chat heading. Only a failing wait takes longer.
configure({ asyncUtilTimeout: 3000 });

beforeAll(() => {
  setGlobalDispatcher(connectionPerRequest);
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetMockApi();
  resetCognitoMock();
});
afterAll(() => server.close());
