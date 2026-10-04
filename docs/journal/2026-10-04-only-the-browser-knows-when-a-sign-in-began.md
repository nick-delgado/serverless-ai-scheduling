# 2026-10-04 — Only the browser knows when a sign-in began, so the restore rule lives in the SPA

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #27, #104, #36, ADR-007, PRD FR-014, FR-015, FR-017, NFR-005

## What happened

#27 made the chat page's failures recoverable and its reloads painless. A failed turn now ends in an error bubble in the conversation, under the patient's message, which stays. Retry shows only when the failure can be retried: a stream `error` event with `retryable: true`, or a network failure. It resends the same text with the same `clientMessageId` and `conversationId`, so #104's server-side de-duplication can recognise the repeat. Any other failure shows its own message without Retry: the daily cap gives the front desk's number and hours, and a 401 says the sign-in has ended and signs the patient out, which takes them to the sign-in page.

On load, the page restores the conversation from `POST /api/session`, but only under the login-session rule. The endpoint returns the patient's newest conversation ever, with no notion of when this sign-in started. Only the browser knows that. So the SPA keeps `{ sub, conversationId }` in `localStorage`: written when a turn's `done` names the conversation, and cleared on sign-in, on sign-out, and when Amplify reports the sign-in ended (`signedOut`, `tokenRefresh_failure`). A session whose conversation isn't the stored one, or whose patient isn't the stored `sub`, starts the page empty, and the next turn starts a new conversation.

A failed session call is no longer silent. The fallback greeting still appears, so the page opens, and an error with Retry sits under it. A 401 routes to sign-in.

## Why we chose what we chose

- **Clearing on sign-in too, not only on sign-out.** The issue names sign-out and Amplify's two events. But a refresh token can expire while no tab is open: no event fires, and the stored conversation stays. When the same patient signs in again, the `sub` matches, and without a clear on sign-in the old conversation would come back. A new sign-in is a new login session by definition, so `AuthProvider.signIn` clears it.
- **The `sub` comes from Amplify's `getCurrentUser().userId`.** `AuthUser` had only `username`. We added `sub` there rather than decoding the ID token in the chat page. The chat page takes it from the auth context, with a prop for tests.
- **A session call that fails after the patient has already sent a message is not reported.** The turn has started a conversation of its own, and a restore or an error about loading would only confuse. A session that answers late is ignored for the same reason.
- **Retry on a failed session call is offered for every failure but a 401.** It's a read, so repeating it is safe; the chat-turn rule (retryable or network only) exists because a turn writes.
- **An HTTP error with no `error` event in its body (a gateway 502) gets no Retry.** The issue's rule is explicit: Retry for a retryable event or a network failure. A 502 is neither. The patient can still send again.
- **Retry puts focus back in the message box.** The button removes itself, and focus would otherwise fall to the page body (NFR-005).

## What surprised us

The agent ran a script of 72 breaks against the new code, one at a time: each operand, branch, copied value, guard and wait. Three stayed green. Two are equivalent rewrites that no input can tell apart (`stored?.sub` for `stored !== undefined && stored.sub`, and a type cast for an `instanceof` that no other error can satisfy). The third was real. Removing the guard "don't restore over a turn the patient already sent" left its own test green. That test let the turn finish before the delayed session call answered, and the turn's `done` had already written its new conversation to the store, so the restore no longer matched anyway. The guard matters only while the turn is still running. The test now holds the turn open while the session answers, and it fails without the guard.

## Evidence

- Break script: 72 breaks, each one run against the tests that cover it. After the fix above, 70 turn at least one test red, and the 2 that don't are the equivalent rewrites. The PR lists each break with a test that failed.
- New tests: `src/chat/ChatPage.errors.test.tsx` (Retry), `ChatPage.restore.test.tsx` (restore and session failures), `ChatPage.auth.test.tsx` (the rule through the app's auth), `loginSession.test.ts` (the store).

## What's next

- #104 makes a retried send idempotent on the server. Until then, a retry after the message was stored stores it again and counts another turn, and a retry after a failed first turn starts a new conversation.
- #36 passes the login's token getter in, so the 401 paths meet real tokens.
