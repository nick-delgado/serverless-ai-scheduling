/**
 * The bot check the request-access route runs before it creates anything (#357, owner decision r1/Q-1 (a)):
 * Cloudflare Turnstile. The page loads Cloudflare's widget with a public site key and sends the token it gets;
 * this module posts that token and the secret key to Cloudflare's `siteverify` endpoint and reads `success`.
 *
 * What Cloudflare sees: the visitor's IP address, TLS fingerprint and User-Agent, from the widget in the browser
 * (Turnstile privacy addendum), and from this server the token and the secret. We never send `remoteip`, so the
 * server side adds no address. Cloudflare rejects a token it has already validated (`timeout-or-duplicate`) and
 * one older than 300 seconds, so a replayed token fails here without any state of ours.
 *
 * Fail closed: when Cloudflare can't be reached, answers badly or reports a problem with our own secret, the result
 * is `unavailable`, which the handler turns into "try again". Only a verdict from Cloudflare is `rejected`.
 * Neither the token nor the secret is ever logged or put in an error message.
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** How long we wait for Cloudflare before failing closed. */
export const SITEVERIFY_TIMEOUT_MS = 4000;

export type BotCheckResult = { ok: true } | { ok: false; reason: "rejected" | "unavailable" };

/** Verifies one bot-check token. The handler injects it, so tests need no network. */
export type BotVerifier = (token: string) => Promise<BotCheckResult>;

/** Error codes that are our fault or Cloudflare's, not the visitor's: the request fails closed as `unavailable`. */
const SERVER_SIDE_CODES = new Set(["missing-input-secret", "invalid-input-secret", "internal-error"]);

export interface TurnstileOptions {
  /** The widget's secret key (NoEcho `TurnstileSecret`). */
  secret: string;
  /**
   * The hostname Cloudflare must report the challenge was served on (the env's CloudFront domain). Empty or
   * omitted skips the check; Cloudflare's test secret keys report `example.com`.
   */
  expectedHostname?: string;
  /** `fetch`, injectable for tests. */
  fetch?: typeof fetch;
}

export function createTurnstileVerifier(options: TurnstileOptions): BotVerifier {
  const doFetch = options.fetch ?? fetch;
  return async (token) => {
    if (token.length === 0) return { ok: false, reason: "rejected" };
    let body: unknown;
    try {
      const response = await doFetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No `remoteip`: the reviewer's address stays out of what this server sends.
        body: JSON.stringify({ secret: options.secret, response: token }),
        signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
      });
      if (!response.ok) return { ok: false, reason: "unavailable" };
      body = await response.json();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (typeof body !== "object" || body === null) return { ok: false, reason: "unavailable" };
    const { success, hostname, "error-codes": codes } = body as Record<string, unknown>;
    if (success !== true) {
      const serverSide = Array.isArray(codes) && codes.some((c) => SERVER_SIDE_CODES.has(String(c)));
      return { ok: false, reason: serverSide ? "unavailable" : "rejected" };
    }
    if (options.expectedHostname && hostname !== options.expectedHostname) {
      return { ok: false, reason: "rejected" };
    }
    return { ok: true };
  };
}
