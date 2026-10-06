/**
 * Is this model-call error throttling? One rule for the chat handler (429 `RATE_LIMITED` "busy" instead of
 * 503, ADR-007) and the eval harness (retry with backoff and count a throttle, ADR-008), which each kept
 * their own copy until #105.
 *
 * Throttling, by either of two signals:
 * - **The error's `name`** is one of `THROTTLE_NAMES`, read by `errorNameOf` from any object, not only
 *   an `Error` (r1/A-3). The set is the union of the two old copies (r1/Q-2): `ThrottlingException` and
 *   `TooManyRequestsException` (both), `ServiceQuotaExceededException` (the API's: an account quota is
 *   a busy model, FR-015) and `Throttling` (the evals': the bare name some AWS clients use).
 * - **Its HTTP status** is 429, from `httpStatusOf`.
 *
 * `httpStatusOf` reads `$metadata.httpStatusCode` (the AWS SDK v3's field), then `statusCode`, then
 * `status` (other clients' and hand-built errors'); the first one defined wins, and it counts only if it
 * is a number (r1/A-2). The evals' `isRetryable` uses both readers, `errorNameOf` for its transient
 * names and `httpStatusOf` for its 5xx check, so the two packages read an error the same way.
 *
 * A pure leaf module (no SDK import), so any caller can use it without pulling in a model client.
 */

/** The error names that mean throttling (r1/Q-2: the union of the API's and the evals' sets). */
export const THROTTLE_NAMES: ReadonlySet<string> = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceQuotaExceededException",
  "Throttling",
]);

/** A field of an unknown error value, if it is an object that has it. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The `name` an error carries, if it is an object with a string `name` (an `Error` or a plain object). */
export function errorNameOf(error: unknown): string | undefined {
  const name = field(error, "name");
  return typeof name === "string" ? name : undefined;
}

/** The HTTP status an error carries: `$metadata.httpStatusCode ?? statusCode ?? status`, if a number. */
export function httpStatusOf(error: unknown): number | undefined {
  const status =
    field(field(error, "$metadata"), "httpStatusCode") ??
    field(error, "statusCode") ??
    field(error, "status");
  return typeof status === "number" ? status : undefined;
}

/** A throttling error: a name in `THROTTLE_NAMES`, or HTTP status 429. */
export function isThrottle(error: unknown): boolean {
  const name = errorNameOf(error);
  return (name !== undefined && THROTTLE_NAMES.has(name)) || httpStatusOf(error) === 429;
}
