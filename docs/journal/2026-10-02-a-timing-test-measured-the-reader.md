# 2026-10-02 — A timing test measured the reader, not the mock

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #109, PR #95 (review finding `974c582/TEST-1`), PR #102's CI run, ADR-007, PRD FR-013

## What happened

PR #102 changed only the system prompt and the eval harness, but its CI run failed in `apps/web`: "waits eventIntervalMs between events after the first" got `expected 13.515724000000318 to be greater than or equal to 18`. A re-run passed. The test came from #95's review round, and it had passed locally and on the CI runs for #95 and #96.

The test configured a 25 ms interval and checked that every gap between two consecutive arrivals at the reader was at least 18 ms. That gap has no lower bound. If the reader picks up one event late, the event after it is already queued, so the next gap shrinks even though the mock waited the full 25 ms. A runner busy with 57 test files makes late reads likely.

We split the check in two. Through the handler, with real timers, the test now asserts a bound that late reads can't break: the stream can't end sooner than (events − 1) × 20 ms after the request. The spacing of each event moved to `ndjsonStream` itself under fake timers, where event *k* must not be readable 1 ms before its interval and must be readable at it. No wall clock is involved there.

## Why we chose what we chose

- **A wider margin** (say 10 ms instead of 18) would only make the failure rarer. Any bound on the gap between two arrivals can be broken by a late enough read.
- **A bound per event measured from the request** (event *k* no sooner than *k* × 20 ms) holds under load, but it can't see a missing wait before the second event: in our local runs the first event already arrived about 20 ms after the request (fetch and MSW overhead), so the bound for event 1 is met anyway. We broke it to check, and the test stayed green.
- **Fake timers on `ndjsonStream` directly**, rather than through MSW and fetch: it is already exported for its abort test, so the fake-timer test reads its body with no interception layer between the timers and the stream.

## What surprised us

The flaky test was written by a review round asking for exactly this guard (TEST-1: "each fails if its `sleep` is removed"). It did fail when the sleep was removed. It also failed sometimes when the sleep was there. "Seen failing when broken" says nothing about "never failing when correct".

## Evidence

- Simulated late read (the reader held 40 ms after its second read): the old assertion's smallest gap was 9 ms against the 18 ms it needs; the new bound held, at 320 ms against 220 ms.
- Breaks, each seen failing: no interval wait (both tests); no wait before the second event (fake-timer test); a wait 2 ms short (fake-timer test); the handler passing 0 instead of `eventIntervalMs` (handler test).
- `apps/web/src/mocks/handlers.test.ts` run 15 times while the full suite ran alongside: 15 of 15 passed.

## What's next

- When a timing test needs a bound, take it from a fixed starting point (the request) or from fake time, never from the gap between two observations.
