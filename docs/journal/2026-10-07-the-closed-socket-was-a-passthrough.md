# 2026-10-07 — The scroll test's closed socket was a connection MSW handed to the real network

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #206, PR #214, issue #134 / PR #205, the [2026-10-06](2026-10-06-the-web-tests-wait-by-hops-not-seconds.md) and [2026-10-04](2026-10-04-the-scroll-test-ran-out-of-findbytext.md) entries

## What happened

#134 left one failure under load that wasn't about waiting. The chat page's scroll test sometimes failed because the chat request's `fetch` rejected with Undici's `SocketError: closed`. Issue #206 asked us to find the cause in the test transport and fix it there, with a reproduction that fails without the fix.

The agent rebuilt #134's temporary logging (removed before every commit) and extended it with Undici's diagnostics channels. It tagged every socket, recorded which request went out on which one, and logged who destroyed each socket, with a stack. Running `ChatPage.test.tsx` 36 times in parallel on Node 26.9.0 reproduced the failure 7 times out of 36, then 12 out of 36. Every failure was the scroll test, and the trace was the same each time:

1. Node's `fetch` is Undici, and MSW 3 (`@mswjs/interceptors` 0.45.6) answers it at the socket level, so Undici's own keep-alive pool holds the mock's connections. The chat request reuses the session request's socket.
2. The test before the scroll test ("stops the request and the typing when the page unmounts") aborts its chat request mid-stream. That socket's `close` arrives late, during the scroll test. Undici then reopens the connection for the aborted request and writes nothing to it.
3. The interceptor has a rule for protocols where the server speaks first. A connection the client reads from but hasn't written to within one `setImmediate` is passed through to the real network. Nothing listens at the page's origin (`localhost:3000`), so the real connection is refused, and the socket is destroyed from the interceptor's `#onRealSocketError` with an `AggregateError`.
4. On a quiet machine the refusal arrives first, and the extra connection does no harm. Under load, the pool sends the scroll test's chat request over that connection first, and the request fails with `SocketError: closed`.

So the cause lies in third-party code: Undici reconnecting for an aborted request, together with the interceptor's passthrough rule. Our change is a mitigation in the test transport (r1/Q-1). `src/mocks/node.ts` now exports `connectionPerRequest`, an `undici` dispatcher that gives every request a client of its own and closes it once that request is dispatched. `src/test/setup.ts` installs it with `setGlobalDispatcher` before the mock server starts listening. No request shares a connection with another, nothing retries, and no wait or timeout changed.

## Why we chose what we chose

- **One connection per request, rather than finding the exact Undici bug.** r1/Q-1 had already settled where the fix goes and what shape it takes. A dispatcher without connection reuse makes the pool's behaviour after an abort irrelevant, whichever Undici version is underneath. We declared `undici` as an `apps/web` devDependency (`^8.11.2`, the version already hoisted for jsdom). It reaches both Node versions' `fetch` because undici 8's `setGlobalDispatcher` sets both global dispatcher symbols, and the web suite passes on Node 24.21.0 and on Node 26.9.0.
- **The reproduction (r1/Q-2).** `src/mocks/node.test.ts` forces the condition. It aborts a request mid-response on a kept-alive connection to a real local server's origin, which then receives the passed-through connection. The server resets that connection while the next request waits in its mock handler. That request then fails without the fix and is answered with it. The real server stands in for the refused connection at `localhost:3000`, because a refusal's timing can't be controlled. On Node 24 (Undici 7) the reopened connection is destroyed before any request uses it, so this test passes there with or without the fix. A second test, "sends each mock API request over a connection of its own", fails without the fix on both versions and is the check CI runs on Node 24. A third test checks that each connection closes once its response ends.
- **Four tests changed outside the "workaround only" limit (Nick's decision on the issue, [comment](https://github.com/nick-delgado/serverless-ai-scheduling/issues/206#issuecomment-6046867027)).** Two tests in `useChat.test.tsx` and two in `ChatPage.errors.test.tsx` called `renderHook(() => useChat(createChatApi(), …))`, which builds a new api on every render and so reruns `useChat`'s session effect on every render. Once session requests succeeded, the effect looped until the test timed out. We counted 43,757 session requests in "keys the reply with the messageId from done". Before the fix, that test's session requests were aborted, or one failed on a passed-through connection (`AggregateError`), so the loop never started. The agent took `createChatApi()` out of the render callback in those four tests: hoisted into a `const` in `useChat.test.tsx`, and passed as `renderHook`'s `initialProps` in `.errors`, so the two files don't repeat each other's lines (`dup:changed`).

## What surprised us

- **Four tests passed only because of the bug.** The same passthrough that broke the scroll test under load was quietly failing session requests on a quiet machine, and four `useChat` tests relied on that.
- **The undici package's own `Agent` also passes the reproduction.** A keep-alive `new Agent()` from undici 8.11.2 passes the forced test (though not the "own connection" test). Node 26's bundled Undici 8.10.2 doesn't. We didn't find which change accounts for that.
- **Our load rounds were killed from inside.** Two attempts at a round died partway, the whole chain at once. With each suite in its own session (`setsid`), only single suites died (`Killed: 9`), three of the 18 in the after rounds. We suspect a process-group kill in `scripts/mutate.test.ts` ("kills a timed-out command's whole process group…") reaching the wrong group under load, but we haven't verified that.
- **#134's earlier scroll flakes fit this mechanism, but only partly confirmed.** The 2026-10-04 and 2026-10-06 entries saw scroll failures under load. In this issue's before rounds, one of three scroll failures logged `SocketError: closed`. The other two failed with no rejected `fetch` logged: one at the chip step and one at the last step. Their cause is not identified.

## Evidence

- Six parallel full `npx vitest run` suites per round from the repo root, without coverage, three rounds before at `6d1e593` and three after at `f86d357`, back to back on one 8-core machine (2026-10-07, 17:13–17:58). Load average sampled every 5 s; median (max) per round: before 139 (197), 260 (489), 151 (232); after 303 (419), 134 (182), 91 (153). DynamoDB Local was up throughout, but under load its reachability probe skipped some DynamoDB tests in 17 of 18 before suites and 14 of 15 after suites.
- Complete suites: 18 before and 15 after (the three after suites killed by signal 9 aren't counted; their `fetch` logs have no `SocketError` either).
- Web tests (own / knock-on), before → after:
  - scroll test: 3 / 0 → 0 / 0;
  - "cut mid-way": 0 / 0 → 0 / 0;
  - `VoiceInput.test.tsx` "opens the overlay…": 2 / 0 → 0 / 0;
  - `src/auth/session.test.ts`, the known failure under load (A-2): "uses the Cognito mock in development" 18 / 0 → 15 / 0, with its two knock-ons 0 / 8 and 0 / 14 → 0 / 4 and 0 / 13.
  - No other web test failed in any round.
- `fetch` rejections with `SocketError: closed`: before 1 (the scroll test), after 0.
- `ChatPage.test.tsx` 36 times in parallel: before 7 out of 36, then 12 out of 36, all the scroll test, each with a socket destroyed from `#onRealSocketError`. After: 36 out of 36 passed, with no `SocketError` and no passed-through socket (load average 49 at the end).
- Mutation run: `npm run mutate -- edits.json --markdown -- npx vitest run apps/web/src/mocks/node.test.ts` on Node 26. All 3 edits were killed: removing `setGlobalDispatcher(connectionPerRequest)`, reusing one client per origin, and dropping `client.close()`. The table is in the PR.

## What's next

- `src/auth/session.test.ts` and `src/app/routes.test.tsx` still have fixed-time waits for real I/O (the 2026-10-06 entry).
- If load measurements continue, find out what SIGKILLs suites mid-round before trusting another round's counts.
