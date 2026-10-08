/**
 * The mock API for Vitest (installed by src/test/setup.ts). Tests start with no delays and no
 * faults; change that per test with `configureMockApi`, which resets after each test.
 *
 *   configureMockApi({ chatFault: "mid_stream" });
 *   configureMockApi({ firstEventMs: 50 }); // with vi.useFakeTimers() if you don't want to wait
 *
 * It also exports `connectionPerRequest`, the Undici dispatcher setup.ts gives the tests' `fetch` (#206).
 */
import { setupServer } from "msw/node";
import { Client, Dispatcher } from "undici";

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

/**
 * The tests' `fetch` is Node's Undici, and MSW answers it at the socket level, so Undici's pool holds
 * the mock's connections. MSW's interceptor passes a connection the client reads from but hasn't
 * written to within a `setImmediate` through to the real network (where nothing listens at the page's
 * origin). With Node 26's bundled Undici (8.10.2), when a request is aborted mid-response (the chat
 * page unmounting), Undici reopens its connection and writes nothing to it, so the interceptor passes
 * it through; on a loaded runner the pool then sent the next request over it before the refusal came
 * back, and that request failed with `SocketError: closed` (#206; node.test.ts reproduces it).
 *
 * This dispatcher gives every request a client of its own (from the `undici` package), closed as soon
 * as its request is dispatched: it finishes that request, then closes its connection and takes no
 * other, so no request shares a connection with another. Nothing is retried.
 *
 * Why not undici's `new Agent({ pipelining: 0 })`, which turns keep-alive off: it passes node.test.ts
 * too (on Node 24.21.0 and 26.9.0, run once by hand in PR #214's review round), so no test shows that
 * it falls short; we kept this class on untested reasoning, that a pool shared per origin may still
 * reopen a connection for an aborted request, which a client closed after its one request cannot.
 */
class ConnectionPerRequest extends Dispatcher {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const client = new Client(String(options.origin));
    const accepted = client.dispatch(options, handler);
    void client.close();
    return accepted;
  }
}

export const connectionPerRequest = new ConnectionPerRequest();
