# 2026-10-06 — A same-slot reschedule retry is now the repository's success, not the handler's workaround

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #77, PR #203, ADR-004, PRD FR-030, FR-032

## What happened

Each of the five tool PRs (#19–#23) was told to leave shared code alone, so `packages/tools` ended the batch with three copies of `toAppointmentSummary`, two of `toProviderSummary`, three hand-written "has this slot started?" comparisons, a `registry.ts` ↔ `src/tools/*` import cycle, and a hard-coded 500 in two packages. #77 collected them, and Nick added three more items from later reviews and the Stryker trial (#113).

The agent made these changes:

- **Handler module.** `ToolContext`, `ToolHandler`, `toolOk` and `toolFail` moved to `src/handler.ts`. `registry.ts` re-exports them, because `@sched/tools` exposes them only through `export * from "./registry"`. A new test, `test/import-cycle.test.ts`, reads every `src/tools/*.ts` and fails when one imports `../registry`.
- **One mapper module.** The three mappers live once, in `src/tools/summaries.ts`. `toSlotOption` now takes `(slot, provider)`.
- **One bookable rule.** `startsAfter(startUtc, now)` in `clock.ts` is pure: the caller passes the instant it read once, so no comparison moves to another instant. The three tools' four comparisons use it, and a unit test pins the boundary: a start equal to now is false, and 1 ms after it is true.
- **One limit.** `LIMITS.escalationNotificationErrorMaxChars` replaces `NOTIFICATION_ERROR_MAX_CHARS` in the tools package and the literal `max(500)` in the `Escalation` schema.
- **Reschedule retry.** The repository answers a reschedule retry into the slot the appointment already holds as success. `RescheduleResult` has two `ok: true` variants told apart by `alreadyRescheduled` (decision r1/Q-1). Only the retry variant lacks `previous`, so the type rules out a retry that carries a previous time. `SAME_SLOT` and `RescheduleErrorReason` are gone. With them goes the handler's branch that re-read the appointment after `SAME_SLOT` and guarded against it having "vanished".

## Why we chose what we chose

Nick settled the open questions in the readiness review (r1 on #77) before work started:

- **Retry shape (Q-1):** a flag on two success variants. The other option, a separate result kind, would have meant every caller matching three shapes. Book's `alreadyBooked` is a flag too.
- **The DynamoDB race (Q-2):** only the up-front check returns the retry answer. A DynamoDB call that read the appointment before a concurrent move committed still gets `CONFLICT`, and the tool still answers `INTERNAL`, as on `main`. Making that path a success too would mean telling "a retry lost the race" apart from "someone else changed it" inside the transaction's failure codes. It is recorded as a follow-up instead.
- **Established-patient tests (Q-3):** for each of book and reschedule, a case that passes only because of a `BOOKED` history, and a case where the only Brooks appointment is `CANCELLED` and the tool answers `NOT_ALLOWED`. The `CANCELLED` appointment comes from a test-local seed (`test/tools/established.ts`), so `clinic-default.ts` is unchanged.
- **The unreachable guard (Q-4):** `get_my_appointments.ts:47` stays. No input reaches it, because every provider the loop puts in the map was read and checked just above it. Its two Stryker mutants are equivalent.

The agent decided two things the spec left open:

- **The retry answer from the repository reuses the handler's existing `alreadyThere`.** That function reads the appointment's provider again rather than using the slot's provider that the handler already holds. The two are the same provider, since the appointment is in that slot, but reusing the existing path keeps the output identical by construction.
- **`startsAfter` takes a `Date`, not `Date | number`.** `reschedule_appointment` now keeps `now` as a `Date`. The union would have added a branch that only exists to save one `.getTime()`.

## What surprised us

Removing `SAME_SLOT` made the handler shorter in a way that is easy to miss. The "vanished after `SAME_SLOT`" guard existed only because the repository's failure value carried no appointment, so the handler had to read it again, and that read could in principle find nothing. Once the repository returns the appointment it already read, both the second read and its failure mode disappear. A Stryker survivor from the #93 review (TEST-2b, `spikes/stryker/results/at-555dfc5/mutate-93-review.txt`) tested exactly that guard. That code no longer exists.

## Evidence

- Seen failing: `npm run mutate` with 35 edits over every changed source file, run with DynamoDB Local up so the contract suite ran against both repositories (decision A-9). The table is in the PR.
- Eval: the L1 smoke suite on `sonnet-4.6`, branch and `main`. The rows are in the PR.

## What's next

- A follow-up for the DynamoDB retry that loses the race to the first move (Q-2).
