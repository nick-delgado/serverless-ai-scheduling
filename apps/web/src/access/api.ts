/**
 * `POST /api/request-access` (#357): the one call the SPA makes without a token. It sends the bot-check token and
 * nothing about the reviewer, and keeps nothing: the caller holds the result in component state only (A-8).
 */
import { ACCESS_ERRORS, RequestAccessError, RequestAccessResponse } from "@sched/contracts";

export type AccessResult =
  | { ok: true; account: RequestAccessResponse }
  /** The bot check didn't pass: solve it again. */
  | { ok: false; kind: "bot_check"; message: string }
  /** A cap is reached: the message says to contact Nick through the README. */
  | { ok: false; kind: "capped"; message: string }
  /** Anything else, including a network failure and an unreadable answer: try again. */
  | { ok: false; kind: "retry"; message: string };

/** What the page says when the answer can't be read or never came: the server's own try-again text. */
export const RETRY_MESSAGE = ACCESS_ERRORS.TRY_AGAIN.message;

export async function requestAccess(turnstileToken: string, signal?: AbortSignal): Promise<AccessResult> {
  let response: Response;
  try {
    response = await fetch("/api/request-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstileToken }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, kind: "retry", message: RETRY_MESSAGE };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const account = RequestAccessResponse.safeParse(body);
    return account.success
      ? { ok: true, account: account.data }
      : { ok: false, kind: "retry", message: RETRY_MESSAGE };
  }
  const error = RequestAccessError.safeParse(body);
  if (!error.success) return { ok: false, kind: "retry", message: RETRY_MESSAGE };
  const { code, message } = error.data.error;
  if (code === "CAP_REACHED") return { ok: false, kind: "capped", message };
  if (code === "BOT_CHECK_FAILED") return { ok: false, kind: "bot_check", message };
  return { ok: false, kind: "retry", message: code === "TRY_AGAIN" ? message : RETRY_MESSAGE };
}
