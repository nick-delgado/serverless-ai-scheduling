// These helpers run under Vitest in Node, and `until` needs its real `setImmediate`.
/// <reference types="node" />
/**
 * Test helpers for the chat page. Timing tests here follow docs/journal/2026-10-02: fake time for the
 * typewriter, and no assertion on how long real I/O takes.
 *
 * fetch and MSW move a response along with real `setImmediate` hops and microtasks, a number of them
 * that varies by runner. So a test never advances fake time *hoping* the stream has been read: it
 * waits for a DOM condition with `until`, which runs real hops while fake time stands still.
 */
import { type ChatStreamEvent, encodeStreamEvent } from "@sched/contracts";
import { EXAMPLES } from "@sched/contracts/testing";
import { act, fireEvent, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import { NDJSON_CONTENT_TYPE } from "../mocks/handlers";
import { server } from "../mocks/node";

/** Fake setTimeout and Date only: setImmediate and microtasks stay real, so I/O keeps flowing. */
export function fakeTime(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/** Run real I/O hops, without advancing fake time, until `condition` holds (at most 500 hops). */
export async function until(condition: () => boolean): Promise<void> {
  for (let hop = 0; hop < 500; hop += 1) {
    if (condition()) return;
    await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  throw new Error("until: the condition never held");
}

/** Type into the composer and press Enter, synchronously (user-event stalls under fake timers). */
export function sendNow(text: string): void {
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: "Enter" });
}

export const typingIndicator = () => screen.queryByTestId("typing-indicator");

/** The conversation log. */
export const log = () => screen.getByRole("list", { name: "Conversation" });

/** A `reducedMotion` getter that always asks for instant rendering. */
export const instant = () => true;

type DoneEvent = Extract<ChatStreamEvent, { type: "done" }>;

/** The contract's example `done` event, with these fields replaced. */
export function doneEvent(overrides: Partial<DoneEvent> = {}): DoneEvent {
  return { ...EXAMPLES.ChatDoneEvent, ...overrides };
}

export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * Answer `POST /api/chat` with these chunks, each an array of events sent as one network chunk. A
 * chunk index in `holdAt` waits for that promise first. The stream never closes on its own until the
 * last chunk has gone.
 */
export function serveChunks(chunks: ChatStreamEvent[][], holdAt: Record<number, Promise<void>> = {}): void {
  server.use(
    http.post("/api/chat", () => {
      const encoder = new TextEncoder();
      let next = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await holdAt[next];
          const chunk = chunks[next];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          next += 1;
          controller.enqueue(encoder.encode(chunk.map(encodeStreamEvent).join("")));
        },
      });
      return new HttpResponse(body, { headers: { "Content-Type": NDJSON_CONTENT_TYPE } });
    }),
  );
}

/** `serveChunks` with one event per chunk. */
export function serveEvents(events: ChatStreamEvent[], holdAt: Record<number, Promise<void>> = {}): void {
  serveChunks(
    events.map((event) => [event]),
    holdAt,
  );
}
