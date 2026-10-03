/**
 * Knobs for the mock API: timing and error injection. Defaults model the deployed API (ADR-007
 * spike S-2: ~1 s to the first event, ~25 events/s after that).
 */
import { z } from "zod";

export const ChatReply = z.enum(["tools", "plain", "reset"]);
export const ChatFault = z.enum([
  "none",
  "network",
  "unauthorized",
  "rate_limited",
  "unavailable",
  "mid_stream",
]);
export const SessionVariant = z.enum(["upcoming", "no_upcoming", "restore"]);
export const SessionFault = z.enum(["none", "network", "unauthorized", "internal"]);

const ms = (fallback: number) => z.int().min(0).max(60_000).catch(fallback);

export const MockApiOptions = z.object({
  /** Round trip for responses that don't wait on the model: the session call, 401s, 400s, 429/503s. */
  latencyMs: ms(150),
  /**
   * From the chat request to its first event. The response headers arrive with that first event (the
   * Lambda writes its HTTP prelude on the first write), so `fetch()` doesn't resolve before then.
   */
  firstEventMs: ms(1000),
  /** Gap between later chat events. */
  eventIntervalMs: ms(40),
  /**
   * What a successful chat turn streams:
   * - `tools`: a `check_availability` status, then the reply;
   * - `plain`: text only;
   * - `reset`: text, a `text_reset` that keeps part of it, a status, then the rest.
   */
  chatReply: ChatReply.catch("tools"),
  /**
   * Error injection for `POST /api/chat`:
   * - `network`: the request fails (fetch rejects);
   * - `unauthorized`: API Gateway's own 401 `{"message":"Unauthorized"}`;
   * - `rate_limited` / `unavailable`: 429 / 503 with one retryable NDJSON `error` event;
   * - `mid_stream`: 200, part of the reply, then a retryable `error` event.
   */
  chatFault: ChatFault.catch("none"),
  /** Which session `POST /api/session` returns: with an upcoming appointment, without, or a conversation to restore. */
  session: SessionVariant.catch("upcoming"),
  /** Error injection for `POST /api/session`: `internal` is a 500 with an `ApiError` body. */
  sessionFault: SessionFault.catch("none"),
});
export type MockApiOptions = z.infer<typeof MockApiOptions>;

/** Read options from untrusted input (local storage, a console call). Bad or missing fields get their defaults. */
export function parseMockApiOptions(raw: unknown): MockApiOptions {
  const input = typeof raw === "object" && raw !== null ? raw : {};
  return MockApiOptions.parse(input);
}

export const DEFAULT_MOCK_API_OPTIONS: MockApiOptions = parseMockApiOptions({});

/** For unit tests: no delays. */
export const INSTANT_MOCK_API_OPTIONS: MockApiOptions = {
  ...DEFAULT_MOCK_API_OPTIONS,
  latencyMs: 0,
  firstEventMs: 0,
  eventIntervalMs: 0,
};
