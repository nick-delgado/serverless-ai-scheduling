/**
 * Pacing for live model calls (#34 note, ADR-002/ADR-010): one token bucket per model ID, shared by every
 * live call in the process (agent, patient simulator #31, judge #32), plus retry with exponential
 * backoff on throttling (429) and transient 5xx errors.
 *
 * Wrap every live `LlmClient` with `rateLimited(client)`; they all draw from `SHARED_RATE_LIMITER` unless
 * given another limiter. The SDK's own retries should be off (`maxAttempts: 1`) so a retry also waits for
 * a token instead of bypassing the bucket.
 */
import type { LlmCallOptions, LlmClient, LlmRequest, LlmResponse, LlmStreamHandlers } from "@sched/agent";

export interface Timer {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The abort reason as an Error (an AbortSignal's reason is `any`). */
const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));

export const realTimer: Timer = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(abortError(signal));
        },
        { once: true },
      );
    }),
};

/**
 * On-demand requests per minute this account gets, by model family (quota figures as of 2026-09-29, #34
 * and spike S-1c). Claude is at 10 RPM until the increase in #49 lands.
 */
export function defaultRpmFor(modelId: string): number {
  if (modelId.includes("anthropic.claude")) return 10;
  if (modelId.includes("gpt-oss")) return 100;
  if (modelId.includes("nova-pro")) return 25;
  if (modelId.includes("nova")) return 20;
  return 10;
}

/** A token bucket holding one token, refilled continuously at `ratePerMinute` (no bursts). */
export class TokenBucket {
  readonly #ratePerMs: number;
  readonly #timer: Timer;
  #tokens: number;
  #last: number;
  /** Serializes waiters so tokens are handed out in arrival order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(ratePerMinute: number, options: { timer?: Timer } = {}) {
    if (!(ratePerMinute > 0)) throw new RangeError(`ratePerMinute must be > 0, got ${ratePerMinute}`);
    this.#ratePerMs = ratePerMinute / 60_000;
    this.#timer = options.timer ?? realTimer;
    this.#tokens = 1;
    this.#last = this.#timer.now();
  }

  #refill(): void {
    const now = this.#timer.now();
    this.#tokens = Math.min(1, this.#tokens + (now - this.#last) * this.#ratePerMs);
    this.#last = now;
  }

  /** Wait for one token. */
  take(signal?: AbortSignal): Promise<void> {
    const next = this.#queue.then(async () => {
      for (;;) {
        this.#refill();
        if (this.#tokens >= 1) {
          this.#tokens -= 1;
          return;
        }
        await this.#timer.sleep(Math.ceil((1 - this.#tokens) / this.#ratePerMs), signal);
      }
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

export interface RateLimiterOptions {
  /** RPM per model ID. Default `defaultRpmFor`. */
  rpmFor?: (modelId: string) => number;
  /** Fraction of quota to use, leaving headroom for other callers. Default 0.9. */
  utilization?: number;
  timer?: Timer;
}

/** One bucket per model ID, created on first use. */
export class RateLimiter {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #options: Required<RateLimiterOptions>;

  constructor(options: RateLimiterOptions = {}) {
    this.#options = {
      rpmFor: options.rpmFor ?? defaultRpmFor,
      utilization: options.utilization ?? 0.9,
      timer: options.timer ?? realTimer,
    };
  }

  get timer(): Timer {
    return this.#options.timer;
  }

  acquire(modelId: string, signal?: AbortSignal): Promise<void> {
    let bucket = this.#buckets.get(modelId);
    if (bucket === undefined) {
      bucket = new TokenBucket(this.#options.rpmFor(modelId) * this.#options.utilization, {
        timer: this.#options.timer,
      });
      this.#buckets.set(modelId, bucket);
    }
    return bucket.take(signal);
  }
}

/** The process-wide limiter every live call shares. */
export const SHARED_RATE_LIMITER = new RateLimiter();

const THROTTLE_NAMES = new Set(["ThrottlingException", "TooManyRequestsException", "Throttling"]);
const TRANSIENT_NAMES = new Set([
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelNotReadyException",
  "ModelStreamErrorException",
]);

/** A field of an unknown error value, if it is an object that has it. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

function statusOf(error: unknown): number | undefined {
  const status =
    field(field(error, "$metadata"), "httpStatusCode") ??
    field(error, "statusCode") ??
    field(error, "status");
  return typeof status === "number" ? status : undefined;
}

/** A 429 / throttling error (retry after a wait). */
export function isThrottle(error: unknown): boolean {
  const name = field(error, "name");
  return (typeof name === "string" && THROTTLE_NAMES.has(name)) || statusOf(error) === 429;
}

/** Worth retrying: throttling, or a transient 5xx from the service. */
export function isRetryable(error: unknown): boolean {
  const name = field(error, "name");
  const status = statusOf(error);
  return (
    isThrottle(error) ||
    (typeof name === "string" && TRANSIENT_NAMES.has(name)) ||
    (status !== undefined && status >= 500 && status < 600)
  );
}

export interface RateLimitedOptions {
  limiter?: RateLimiter;
  /** Retries after the first attempt. Default 6. */
  maxRetries?: number;
  /** First backoff; doubles each retry, with equal (half) jitter: half the step fixed, half random. Default 2 s. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 60 s. */
  maxDelayMs?: number;
  /** Jitter source in [0, 1). Default `Math.random`. */
  random?: () => number;
  /** Called on each retry (for logs and the results file). */
  onRetry?: (info: { modelId: string; attempt: number; delayMs: number; error: unknown }) => void;
}

/** Counters a run reports next to cost and wall-clock. */
export interface RateLimitStats {
  calls: number;
  retries: number;
  throttles: number;
}

/**
 * An `LlmClient` that waits for its model's token before every attempt and retries retryable errors
 * with exponential backoff. Non-retryable errors, and the last retryable one, propagate unchanged.
 */
export class RateLimitedLlmClient implements LlmClient {
  readonly stats: RateLimitStats = { calls: 0, retries: 0, throttles: 0 };
  readonly #inner: LlmClient;
  readonly #limiter: RateLimiter;
  readonly #options: Required<Omit<RateLimitedOptions, "limiter" | "onRetry">> &
    Pick<RateLimitedOptions, "onRetry">;

  constructor(inner: LlmClient, options: RateLimitedOptions = {}) {
    this.#inner = inner;
    this.#limiter = options.limiter ?? SHARED_RATE_LIMITER;
    this.#options = {
      maxRetries: options.maxRetries ?? 6,
      baseDelayMs: options.baseDelayMs ?? 2_000,
      maxDelayMs: options.maxDelayMs ?? 60_000,
      random: options.random ?? Math.random,
      onRetry: options.onRetry,
    };
  }

  async streamMessage(
    request: LlmRequest,
    handlers?: LlmStreamHandlers,
    options: LlmCallOptions = {},
  ): Promise<LlmResponse> {
    for (let attempt = 0; ; attempt++) {
      await this.#limiter.acquire(request.modelId, options.signal);
      this.stats.calls += 1;
      try {
        return await this.#inner.streamMessage(request, handlers, options);
      } catch (error) {
        if (!isRetryable(error) || attempt >= this.#options.maxRetries) throw error;
        if (isThrottle(error)) this.stats.throttles += 1;
        this.stats.retries += 1;
        const ceiling = Math.min(this.#options.maxDelayMs, this.#options.baseDelayMs * 2 ** attempt);
        const delayMs = Math.round(ceiling / 2 + (this.#options.random() * ceiling) / 2);
        this.#options.onRetry?.({ modelId: request.modelId, attempt: attempt + 1, delayMs, error });
        await this.#limiter.timer.sleep(delayMs, options.signal);
      }
    }
  }
}

/** Wrap a live client so it shares the process-wide limiter. */
export const rateLimited = (client: LlmClient, options: RateLimitedOptions = {}): RateLimitedLlmClient =>
  new RateLimitedLlmClient(client, options);
