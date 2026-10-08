// These tests open a real TCP server and watch Undici's sockets, so they need Node's own modules.
/// <reference types="node" />
/**
 * The test transport (#206): how the web tests' `fetch` reaches the mock API (`connectionPerRequest`;
 * node.ts's header says why the mock's connections can fail). The second test forces that failure with
 * a real server that resets its connection. On Node 24 (Undici 7) the reopened connection is destroyed
 * before any request uses it, so that test passes there with or without the fix, and the first test is
 * the one that checks the fix there.
 */
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { createServer, type Socket } from "node:net";

import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createChatApi } from "../chat/api";
import { gate, until } from "../chat/testUtils";
import { server } from "./node";

/**
 * Run real `setImmediate` hops until `condition` holds or `maxHops` have passed, without failing. It is
 * for a fixed pause and for waits that may never hold (with the fix, nothing reconnects); a wait that
 * must hold uses `until`.
 */
async function hopsUntil(condition: () => boolean, maxHops: number): Promise<void> {
  for (let hop = 0; hop < maxHops && !condition(); hop += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A real server on a free local port. It answers anything it reads with 418, so a request that reaches
 * it, instead of the mock, shows up as that status. It counts its connections and requests, and can
 * reset its connections, as a refused connection fails.
 */
async function startRealServer(): Promise<{
  origin: string;
  connections: () => number;
  requests: () => number;
  resetConnections: () => void;
}> {
  let connections = 0;
  let requests = 0;
  const sockets = new Set<Socket>();
  const real = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("data", () => {
      requests += 1;
      socket.end("HTTP/1.1 418 I'm a teapot\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => real.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    real.close();
  });
  const address = real.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
    requests: () => requests,
    resetConnections: () => {
      for (const socket of sockets) socket.resetAndDestroy();
    },
  };
}

/** The socket each request's headers go out on, in order, from Undici's diagnostics channel. */
function recordRequestSockets(): object[] {
  const sockets: object[] = [];
  const onSendHeaders = (message: unknown) => sockets.push((message as { socket: object }).socket);
  subscribe("undici:client:sendHeaders", onSendHeaders);
  cleanups.push(() => unsubscribe("undici:client:sendHeaders", onSendHeaders));
  return sockets;
}

describe("the test transport (#206)", () => {
  it("sends each mock API request over a connection of its own", async () => {
    const sockets = recordRequestSockets();
    const api = createChatApi();
    await api.getSession();
    // A few hops let the session's connection go back to Undici's pool, as the page's render does
    // before it sends; a pool would then send the chat over it.
    await hopsUntil(() => false, 20);
    await api.sendChat(
      { clientMessageId: "7c9e6679-7425-40de-944b-e07fc1f90ae7", text: "Hi" },
      () => undefined,
    );
    expect(sockets).toHaveLength(2);
    expect(sockets[1]).not.toBe(sockets[0]);
  });

  it("keeps a request on the mock when the connection Undici reopened after an aborted request fails (forces the failure on Node 26's Undici 8.10)", async () => {
    const real = await startRealServer();
    const reachedHandler = gate();
    const answer = gate();
    server.use(
      http.post(`${real.origin}/json`, () => HttpResponse.json({ mocked: true })),
      // Headers and one chunk, then the stream stays open, like a chat reply the page stops reading.
      http.post(`${real.origin}/held`, () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first\n"));
          },
        });
        return new HttpResponse(body, { headers: { "Content-Type": "text/plain" } });
      }),
      http.post(`${real.origin}/gated`, async () => {
        reachedHandler.open();
        await answer.promise;
        return HttpResponse.json({ mocked: true });
      }),
    );

    // A request, then one on the same kept-alive connection that the client aborts mid-stream, as the
    // chat page does when it unmounts.
    const first = await fetch(`${real.origin}/json`, { method: "POST" });
    await first.json();
    await hopsUntil(() => false, 20); // back to the pool, as above
    const abort = new AbortController();
    const held = await fetch(`${real.origin}/held`, { method: "POST", signal: abort.signal });
    const reader = held.body?.getReader();
    await reader?.read();
    abort.abort();
    await expect(reader?.read()).rejects.toThrow();
    // Without the fix, Undici reopens the aborted request's connection and writes nothing to it, so
    // the interceptor passes it through to this real server. With it, nothing reconnects; the same
    // steps get a bounded number of hops.
    await hopsUntil(() => real.connections() > 0, 200);

    // The next request goes out; while the mock holds its answer, the real connection fails, as a
    // refused one does at the page's origin, where nothing listens.
    let settled = false;
    const next = fetch(`${real.origin}/gated`, { method: "POST" }).finally(() => (settled = true));
    await reachedHandler.promise;
    real.resetConnections();
    await hopsUntil(() => settled, 200);
    answer.open();

    const response = await next;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mocked: true });
    expect(real.requests()).toBe(0);
    // Nothing reconnected for the aborted request, so the tests open no connection to the real network.
    expect(real.connections()).toBe(0);
  });

  it("closes each connection once its response has ended", async () => {
    const sockets = recordRequestSockets();
    await createChatApi().getSession();
    const socket = sockets[0] as { destroyed: boolean } | undefined;
    await until(() => socket?.destroyed === true);
    expect(socket?.destroyed).toBe(true);
  });
});
