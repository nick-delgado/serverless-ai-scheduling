/**
 * The login session's conversation (FR-014, #27): which conversation this sign-in has been using.
 *
 * A login session is one sign-in, across reloads and tabs, until sign-out or the end of the sign-in
 * (refresh token expired or revoked). `POST /api/session` returns the patient's newest conversation
 * ever, with no login-session cutoff, so only the SPA can tell a reload (restore it) from a new
 * sign-in (start empty). It keeps `{ sub, conversationId }` in `localStorage`, shared by every tab:
 * - written when a turn's `done` names the conversation (useChat);
 * - cleared on sign-in, on sign-out, and when Amplify reports that the sign-in ended
 *   (`signedOut`, `tokenRefresh_failure`), by `AuthProvider`.
 *
 * Storage can be unavailable (a private window, blocked site data). Then nothing is stored, and the
 * chat starts empty on every load, which is the safe side of the rule.
 */
import { ConversationId } from "@sched/contracts";
import { z } from "zod";

export const LOGIN_SESSION_STORAGE_KEY = "sched.loginSession";

const StoredLoginSession = z.object({ sub: z.string().min(1), conversationId: ConversationId });
export type StoredLoginSession = z.infer<typeof StoredLoginSession>;

/** The stored login session, or `undefined` if there is none or it can't be read. */
export function readLoginSession(): StoredLoginSession | undefined {
  try {
    const raw = localStorage.getItem(LOGIN_SESSION_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed = StoredLoginSession.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeLoginSession(session: StoredLoginSession): void {
  try {
    localStorage.setItem(LOGIN_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage blocked: the next load starts empty.
  }
}

export function clearLoginSession(): void {
  try {
    localStorage.removeItem(LOGIN_SESSION_STORAGE_KEY);
  } catch {
    // Storage blocked: there is nothing stored to clear.
  }
}

/**
 * The conversation to restore: the session call's, if it is the one this login session has been using
 * as the patient `sub` is signed in as; otherwise `undefined`, and the chat starts empty.
 */
export function conversationToRestore(
  conversationId: string | null,
  sub: string | undefined,
  stored: StoredLoginSession | undefined,
): string | undefined {
  return stored !== undefined && stored.sub === sub && stored.conversationId === conversationId
    ? stored.conversationId
    : undefined;
}
