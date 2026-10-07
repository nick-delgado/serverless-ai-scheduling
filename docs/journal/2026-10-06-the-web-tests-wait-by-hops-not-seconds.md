# 2026-10-06 — The web tests wait by hops, not seconds, and the last flake under load is a closed socket

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #134, PR #205, issue #206, issue #122 / PR #130, issue #109 / PR #110, PR #133, issue #140, PRD NFR-005, the [2026-10-02](2026-10-02-a-timing-test-measured-the-reader.md) and [2026-10-04](2026-10-04-the-scroll-test-ran-out-of-findbytext.md) entries

## What happened

Several `apps/web` tests waited for real I/O with a fixed time budget: `findBy*` and `waitFor` give up after 3 s (`asyncUtilTimeout`, raised from 1 s by #140), and the announce test stepped 300 `act` ticks inside Vitest's 5 s test timeout. A loaded runner can spend that time before the mock API's response gets through. Issue #134 asked us to stop that and to prove it under the load #122 used.

The agent first measured `main` at `d0098c6`: three rounds of six full `npx vitest run` suites in parallel, on an 8-core machine, with the load average sampled every 5 s. Then it changed the tests and ran the same three rounds, back to back on the same machine, plus one more round at the PR's head.

What changed, by Nick's readiness answers on the issue:

- `until` (`src/chat/testUtils.ts`) now gives up only once it has run 500 hops **and** 3 s of real time has passed (r1/Q-1); it reads the 3 s from `asyncUtilTimeout` rather than keeping its own copy. A new `untilFound` is a `findBy*` with no fixed timeout. `testUtils.test.ts` checks both floors with a stubbed `performance.now()`.
- Every `findBy*` and `waitFor` that waited on MSW I/O in `src/chat/*.test.tsx` now uses `until` or `untilFound` (r1/Q-3). The PR's review found two greeting waits the first pass missed (`ChatPage.test.tsx`, `ChatPage.auth.test.tsx`); after converting them, the agent grepped the five files again, and each remaining `findBy*`/`waitFor` is one of the kinds listed below. A `waitFor` that only covers an effect flush after an `until` stays, by the scroll test's rule.
- The announce test ticks until the bubble shows the whole reply, then for 1 s more, about 160 `act` calls instead of 300. It looks up the conversation list once (r1/Q-4).
- `LoginPage.test.tsx` waits that cross the Cognito mock take an explicit 10 s; waits on `fakeAuthService` keep the 3 s default (r1/Q-2).
- The two 60 ms sleeps that waited out a 30 ms rejection now wait on the rejection itself (A-7).
- `handlers.test.ts` lost its 180 ms wall-clock upper bound. The new check runs under fake time: after `latencyMs` of fake time and nothing more, the headers must arrive. It fails when the handler also waits `firstEventMs`.

## Why we chose what we chose

The issue's decisions settled most of it. Three choices were left to the agent:

- **A 20 s test timeout in each converted file** (`vi.setConfig({ testTimeout: 20_000 })`, as `LoginPage.test.tsx` already had), on top of the shorter announce loop. `ChatPage.voice.test.tsx` and `mocks/handlers.test.ts` also wait with `until` but weren't converted, and keep the 5 s default. Before, the announce test's slowest run took 5.2 s. "#160: when the stream is cut after it", a two-turn test, hit the 5 s timeout in 5 of 18 runs. `until` has no time cap, so a slow wait now ends at the test timeout rather than at `findBy*`'s 3 s. The other option was to change the suite-wide timeout in `src/test/setup.ts`, which A-3 ruled out. The PR's review asked whether the announce test's file should drop it, since r1/Q-4 had chosen a shorter loop over a longer timeout; Nick kept 20 s in every converted file, `ChatPage.test.tsx` included (decision `306785f/SPEC-3`).
- **`untilFound` rather than a pair of lines per wait.** `expect(await untilFound(() => screen.queryByRole("alert")))` keeps each test's query and assertion as they were. Writing `await until(() => … !== null)` followed by a `getBy*` would repeat every query twice. For a `waitFor` on a count or a flag, the agent wrote `await until(<condition>)` and kept the original `expect` after it. That `expect` only restates the condition: a failed wait throws `until: the condition never held` first, so the failure doesn't name what was expected.
- **The fourth criterion, settled by Nick.** The scroll test still failed on its own under load (below), and the cause isn't a wait. Nick moved that failure to issue #206 (the mock transport) on 2026-10-07, so #134 merges with every wait-related failure fixed.
- **Waits left as `waitFor` or `findBy*`.** Some waits don't wait on I/O and were left alone. In `useChat.test.tsx`, the scripted `ChatApi`s resolve with `Promise.resolve`. In `ChatPage.auth.test.tsx`, the sign-out and `emitChange` steps run on `fakeAuthService`. Focus moves happen in effects after a click.

## What surprised us

**`until`'s hop count isn't what runs out.** The agent logged every `until` call that needed more than 50 hops during a full round under load: there were none. The fetch-and-MSW path takes the same few hops however busy the machine is. So the 500-hop floor was never the problem. A wait that gives up after 500 hops is a wait whose condition was never going to hold.

**The scroll test's remaining failures are a dropped connection.** After the change, the scroll test was the only test in the set that still failed (5 of 18 runs, always `until` at the chip step after ~3 s). The agent reproduced it by running `ChatPage.test.tsx` 36 times in parallel (7 failures). The page's DOM at the failure shows the turn already ended with "Something went wrong. Please try again." and Retry. The chat request had failed with `TypeError: fetch failed`, caused by undici's `SocketError: closed` (`onHttpSocketClose`). No longer wait would have saved it. We suspect undici reused a pooled keep-alive socket that closed as the gated stream started, but we haven't verified that. A fix belongs in the mock transport (`src/mocks/node.ts` or the test setup), which is outside #134's paths; it is issue #206. The before runs had the same signature: 3 scroll failures on their own, all `until: the condition never held`. One diagnostic round also had "shows the generic error without Retry for a stream whose last line is cut mid-way" show Retry once, which fits the same network failure.

**Most of the "before" chat failures were one test.** The announce test hit the 5 s timeout in 5 of 18 runs. In 4 of those, the 13 tests after it in `ChatPage.test.tsx` failed too. The timed-out test kept running into theirs, and 38 of those 52 failures took under 20 ms.

## Evidence

Load: three rounds of six `npx vitest run` from the repo root, no coverage, 8 cores. Sampled load average: before, median 226–237 per round (max 292); after, median 192–233 (max 323). "Own" means the failure was the test's own wait or timeout. "Knock-on" means it failed after another test in the same file timed out.

| Test | Before (`d0098c6`), own / knock-on | After, own / knock-on |
|---|---|---|
| announces the completed reply once, never a partial one | 5 test timeouts / 0 (median 3.5 s, max 5.2 s) | 0 / 0 (median 2.4 s, max 3.1 s) |
| the other 13 tests in `ChatPage.test.tsx` that failed with it | 52 failures in the 4 runs where it timed out (38 under 20 ms) | 0 / 0 |
| scrolls the end of the conversation into view… | 3 / 4 (counted in the row above) | 5 / 0 (`fetch failed`: `SocketError: closed`) |
| every `LoginPage.test.tsx` test | 7 (the "Chat" heading at 3 s: 6 in "signs in with Enter", 1 in "from the username field") / 0 | 0 / 0 |
| `ChatPage.errors.test.tsx`: #160, "when the stream is cut after it" | 5 test timeouts / 0 | 0 / 0 |
| other tests whose waits changed (`ChatPage.errors`, `.restore`, `.auth`, `useChat`) | 0 / 0 | 0 / 0 |
| `handlers.test.ts`, the new conversation's headers | 3 (183, 205, 420 ms against `< 180`) / 0 | 0 / 0 |
| `testUtils.test.ts` (new) | not present | 2 test timeouts with a 3000-hop test; cut to 600 checks; 0 of 6 in a final round at the PR head |

- Final round at the PR head (6 suites, load median 127): the scroll test failed once (`until` at the chip step), and nothing else in the set failed.
- `src/auth/session.test.ts` (outside the owned paths) failed every run, before and after: real SRP sign-ins under the 5 s test timeout. It's listed in the PR.
- `npm test` five times in a row: 2808 of 2808 passed each time.
- `npm run mutate`: 17 of 17 breaks killed. Among them: a partial announcement, a second announcement 400 ms later, both floors of `until` and its early return, the aborted-call guard (both strict-mode tests), a restore that waits for the sent turn to end, and headers that wait `firstEventMs`. The table is in the PR.

## What's next

- Issue #206: find out why undici closes the mock's socket under load, and fix it in the mock transport.
- `src/auth/session.test.ts` (outside #134's paths) and `src/app/routes.test.tsx` (inside the owned glob, listed rather than fixed per r1/Q-3) have the same fixed-time waits for real I/O.
