/**
 * NDJSON event streaming over the Lambda response-streaming runtime (ADR-007), moved here from the
 * walking skeleton (#7).
 *
 * The runtime writes the HTTP status/headers prelude on the first write, so the status is chosen
 * lazily: a handler can still answer 400/401/429/503 as long as it hasn't sent an event yet.
 */
import { finished } from "node:stream/promises";

import { encodeStreamEvent, type ChatStreamEvent } from "@sched/contracts";

/** Where events go. The Lambda wraps `awslambda.HttpResponseStream`; tests and evals use `memorySink`. */
export interface EventSink {
  /** Sets the HTTP status and headers. Called exactly once, before the first write. */
  open(statusCode: number): void;
  write(chunk: string): void;
  /** Ends the response. Always called, whatever happened before. */
  end(): Promise<void>;
}

export const NDJSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** An `EventSink` over the runtime's response stream. The status/headers prelude goes out on the first write. */
export function responseStreamSink(responseStream: awslambda.ResponseStream): EventSink {
  let stream = responseStream;
  return {
    open(statusCode) {
      stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode,
        headers: { ...NDJSON_HEADERS },
      });
    },
    write(chunk) {
      stream.write(chunk);
    },
    async end() {
      stream.end();
      try {
        await finished(stream);
      } catch {
        // The client went away mid-stream; there's nobody left to tell.
      }
    },
  };
}

/** What a `memorySink` saw: for tests and in-process eval runs. */
export interface CapturedResponse {
  status: number | undefined;
  /** How many times `open` was called (must be 1). */
  opens: number;
  ended: boolean;
  /** Every event, parsed back from the NDJSON lines. */
  events: ChatStreamEvent[];
  /** The raw body. */
  body: string;
}

export function memorySink(): { sink: EventSink; response: CapturedResponse } {
  const response: CapturedResponse = { status: undefined, opens: 0, ended: false, events: [], body: "" };
  const sink: EventSink = {
    open(status) {
      response.opens += 1;
      response.status = status;
    },
    write(chunk) {
      if (response.status === undefined) throw new Error("write before open");
      if (response.ended) throw new Error("write after end");
      response.body += chunk;
      for (const line of chunk.split("\n")) {
        if (line.trim()) response.events.push(JSON.parse(line) as ChatStreamEvent);
      }
    },
    end() {
      response.ended = true;
      return Promise.resolve();
    },
  };
  return { sink, response };
}

/**
 * Writes events to a sink, opening it with the given status on the first event. Every event is
 * validated against the contract before anything is written (`encodeStreamEvent`).
 */
export class EventWriter {
  readonly #sink: EventSink;
  #opened = false;
  #ended = false;
  #count = 0;

  constructor(sink: EventSink) {
    this.#sink = sink;
  }

  get opened(): boolean {
    return this.#opened;
  }

  /** Events written so far. */
  get count(): number {
    return this.#count;
  }

  /** `statusIfFirst` is used only if this is the first event; afterwards the status is already 200 (or whatever was sent). */
  send(statusIfFirst: number, event: ChatStreamEvent): void {
    if (this.#ended) throw new Error("EventWriter: send after end");
    const line = encodeStreamEvent(event);
    if (!this.#opened) {
      this.#sink.open(statusIfFirst);
      this.#opened = true;
    }
    this.#sink.write(line);
    this.#count += 1;
  }

  /** Ends the response, opening it with `statusIfUnopened` if nothing was sent. Idempotent. */
  async end(statusIfUnopened = 500): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    if (!this.#opened) {
      this.#sink.open(statusIfUnopened);
      this.#opened = true;
    }
    await this.#sink.end();
  }
}
