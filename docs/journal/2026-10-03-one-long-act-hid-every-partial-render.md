# 2026-10-03 — One long act() hid every partial render, so the live-region test couldn't fail

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #26, ADR-007, PRD FR-011, FR-012, FR-013, NFR-005; the timing rules from [2026-10-02](2026-10-02-a-timing-test-measured-the-reader.md)

## What happened

#26 replaced the `/chat` placeholder with the real chat page. The page shows the greeting from `POST /api/session`, and the composer sends on Enter. While a turn is in progress, a typing indicator runs from send to the first `text_delta`, tool-status chips come from `status` events, and a typewriter paces the reply. When the reply has finished typing, a polite live region announces it once. The stream client reads NDJSON or the buffered array through `@sched/contracts`' own parsers.

To meet the definition of done, the agent wrote a script that applies 121 breaks one at a time to the new code and runs the chat tests after each. Each break removes an operand, a guard, a default, a value passed on, or a wait. The first run left seven breaks green. One of them changed the live region to show the reply *as it typed*, exactly what FR-013 forbids, and the test meant to catch it ("announces the completed reply once, never a partial one") still passed.

The cause: the test advanced fake time by 10 s inside a single `act()`. React commits only once the `act()` callback is done, so the MutationObserver on the live region saw one change: the final text. The partials existed in React's state and never reached the DOM. The test now advances one 16 ms tick per `act()` and also checks that the bubble showed more than ten distinct lengths along the way, so it can tell that it watched the typing happen. With the break back in, it fails.

The other survivors fell into two groups:
- **Guards no test could reach, which we removed:** a "nothing to type" check in `#schedule`, and `Math.max(0, …)` on elapsed time. A clock that steps back gives a negative budget and a negative step, and `budget -= step` zeroes it anyway; the test that checks the typewriter doesn't stall stays.
- **A guard we removed by mistake:** we also dropped a `disposed` check in `#maybeComplete` as unreachable. The PR review showed it wasn't: our dispose test stopped with the text half typed, so it never reached that check. With the text fully revealed, `finish()` after `dispose()` still called `onComplete`. `finish()` now returns when disposed, with tests for typed and instant mode that fail without it.
- **Real guards with no test:** a second append during a run started a second timer chain at double speed; an event after `done` was still handed to the page before the stream was rejected; the session call's abort on unmount; `canSend` inside the composer itself. Each now has a test that fails without it.

## Why we chose what we chose

- **Typewriter pace: 60 characters/s, catching up at backlog ÷ 0.75 s.** At the floor of 60/s, a slow trickle reads at an even pace. A faster stream (the ADR-007 spike measured about 25 events/s) is followed with at most about 0.75 s of lag, and a whole buffered reply of 600 characters types out in about 2.7 s. We first tried a 1.5 s window, but a fast stream would then sit 1.5 s behind the network the whole time.
- **The budget comes from wall time, not tick count.** A throttled background tab catches up when it wakes instead of falling further behind. A new run restarts the clock, so a pause between deltas doesn't come back as a burst, and budget a late tick didn't use is dropped.
- **Reduced motion is read when a turn starts**, through `matchMedia`. In that mode each delta renders immediately, and no timer runs at all.
- **The greeting renders whole, without typing.** It's a templated server string (`SessionResponse.greeting`, FR-010), not a streamed agent response, and FR-013's typing is about agent responses. Nick confirmed this in the PR review. While the session loads, the typing indicator shows. If the session call fails, a generic greeting appears so the page still opens. In the review, Nick decided to keep that fallback silent here: surfacing the failure is #27's, since #27 owns the error states.
- **Chips:** one per `status` event, in order. A repeat of the latest label is skipped, and the latest chip is marked current. Chips stay for the whole turn, beside the typing text, and go when the reply is complete. They sit in a `role="status"` region, so a screen reader hears each label once.
- **A turn ends when the typewriter finishes, not when `done` arrives.** Send stays disabled until then, so the next reply can't start while this one is still typing. Typing in the box stays possible.

## What surprised us

Two tests in this PR passed for the wrong reason, and both times the cause was how the test drove time:
- `act()` batching made partial renders invisible, as above.
- An earlier version drove fake time through MSW. It assumed the stream would be read within a fixed fake interval. fetch and MSW move a response along with real `setImmediate` hops, and how many depends on the runner, so after an unrelated refactor the test stopped seeing the first event. The page tests now freeze fake time and wait for a DOM condition with real I/O hops (`until` in `src/chat/testUtils.ts`), or hold the stream with a gate so the order of events is fixed.

user-event also stalls under Vitest fake timers here, even with `delay: null`. Tests that use fake time type with `fireEvent` instead.

## Evidence

- Break script: 121 breaks. After the fixes, every one makes at least one chat test fail, apart from the guards we removed. The PR lists each break with a test that failed.
- `npm run lint && npm run typecheck && npm test` passes at the root. The chat tests (85 of them) passed 12 of 12 runs with 4 runs in parallel. One earlier run of 10, made while the full suite ran alongside, had 1 failure. In that run, tests in other packages timed out too, and some took about 480 s.
- PR review fixes: 18 more breaks, of the fixes and of the paths the review found untested (listed in the PR's review response). Each turned at least one test red. The chat tests are now 97.
- Typewriter defaults: a 600-character burst isn't done after 1 s and is done by 3.5 s (`typewriter.test.ts`, fake timers).

## What's next

- #27 builds the error bubble with Retry and the restore UX on `failTurn`, `ChatHttpError` and `ChatProtocolError`, and surfaces a failed session call (a 401 included), which today falls back silently to the generic greeting.
- #36 passes the login's token getter in through `ChatApiContext`.
