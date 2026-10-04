# 2026-10-04 — The scroll test ran out of findByText's second, not the scroll

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #122, PR #130 (review findings `d4f697d/TEST-1`, `d4f697d/SPEC-2`, `d4f697d/STD-2`), issue #134, issue #109 / PR #110, PRD FR-012

## What happened

The chat page's scroll test ("scrolls the end of the conversation into view when a chip appears and when reply text appears") failed now and then on loaded machines. Issue #122 named two possible causes. Cause 1: the page scrolls in an effect after the render, so an assertion made right after the text appears could run before the effect. Cause 2: `findByText`'s fixed 1 s timeout could run out while the gated MSW stream was still being delivered.

The agent reproduced it before changing anything, on `main` at `7cfc08c`, by running full suites in parallel on an 8-core machine. The scroll test failed on its own only under the heavier load, and every one of those failures was a `findByText` timeout (cause 2). Cause 1 never showed up.

The fix makes each step wait for its text with `until(...)` from `src/chat/testUtils.ts`. `until` counts real I/O hops and has no wall-clock limit. Each scroll check became `waitFor(...)`, so cause 1 is covered too. The test keeps its two scroll checks, for the chip and for the reply text, and adds a wait for the sent message's own scroll before them.

## Why we chose what we chose

The issue left two choices open.

- **`until` for the text, `waitFor` for the scroll call.** `until` alone would work, but when it fails it only says "the condition never held". `waitFor` reports the scroll assertion itself. Each `waitFor` comes after an `until` whose `act` hops flush the commit, so its 1 s covers an effect flush, not I/O. That keeps to the 2026-10-02 rule: no assertion on how long real I/O takes.
- **The shared helpers.** The agent first left `renderPage`'s greeting `findByText` alone, because five tests share it and none of the load runs failed there. The review (`d4f697d/SPEC-2`) pointed out that the greeting comes over the same MSW/fetch path, so the same 1 s timeout could fail there under load. Nick chose option (b): `renderPage` now waits for the greeting with `until(...)`, as `renderAtFakeTime` already did. `sendFromPage` is unchanged. It types with user-event and doesn't wait for any I/O.

## What surprised us

The cause wasn't the one the test's shape suggested. An effect racing an assertion looked likely, but the runs showed the test running out of `findByText`'s budget before the stream arrived.

Our own guard was hollow too. The first version waited for "the sent message's own scroll" before clearing the mock, so that a late call couldn't stand in for the chip's scroll. The review (`d4f697d/TEST-1`) noticed that the mount and greeting scrolls already satisfied that wait, because nothing cleared the mock before the send. The test now clears it once the greeting is shown. With the scroll effect's deps cut to `[chat.greeting]`, the test now fails at the message step. Without that clear, it passed that step and failed only at the chip step.

A timed-out test doesn't stop either. When "announces the completed reply once" hit Vitest's 5 s test timeout, its body kept running into the tests after it, and those failed in milliseconds. Some of the scroll test's failures under load were really failures of a different test.

## Evidence

Load reproduction on `main` at `7cfc08c`, with full `npx vitest run` suites in parallel (other agents were also running suites):

- 4 rounds × 3 suites: 12 of 12 passed.
- 3 rounds × 6 suites: the scroll test failed on its own in 4 of 18 runs, after 1066, 1295, 1348 and 1421 ms. Each was "Unable to find an element with the text" (3 × "Checking availability…", 1 × "Part one."). In 4 other runs it failed in 2–13 ms as a knock-on of the announce test's 5 s timeout.
- After the fix at `d4f697d`, under the same 3 × 6 load: 0 of 18 failures on its own, and 7 knock-on failures in 2–6 ms.

Breaks, each seen failing, at `8135c38`:

- Scroll effect deps cut to `[chat.greeting]`: fails at the message step. With the clear before the send removed, it fails only at the chip step.
- `chat.turn?.chips.length` removed from the deps: fails at the chip step.
- `chat.turn?.text` removed from the deps: fails at the reply-text step.
- `renderPage`'s `until` removed: the scroll test fails at its check that the greeting is shown.

## What's next

- #134: stop the announce test's 5 s overrun, and `LoginPage.test.tsx`'s 1 s waits, from failing under load.
