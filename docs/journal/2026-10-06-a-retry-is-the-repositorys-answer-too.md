# 2026-10-06 — A same-slot reschedule retry is now the repository's success, not the handler's workaround

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #77, PR #203, ADR-004, PRD FR-030, FR-032

## What happened

Each of the five tool PRs (#19–#23) was told to leave shared code alone, so `packages/tools` ended the batch with three copies of `toAppointmentSummary`, two of `toProviderSummary`, four hand-written "has this slot started?" comparisons in three tools, a `registry.ts` ↔ `src/tools/*` import cycle, and a hard-coded 500 in two packages. #77 collected them, and Nick added three more items from later reviews and the Stryker trial (#113).

The agent made these changes:

- **Handler module.** `ToolContext`, `ToolHandler`, `toolOk` and `toolFail` moved to `src/handler.ts`. `registry.ts` re-exports them, because `@sched/tools` exposes them only through `export * from "./registry"`. A new test, `test/import-cycle.test.ts`, reads every `src/tools/*.ts` and fails when one imports `../registry`.
- **One mapper module.** The three mappers live once, in `src/tools/summaries.ts`. `toSlotOption` now takes `(slot, provider)`.
- **One bookable rule.** `startsAfter(startUtc, now)` in `clock.ts` is pure: the caller passes the instant it read once, so no comparison moves to another instant. The three tools' four comparisons use it, and a unit test pins the boundary: a start equal to now is false, and 1 ms after it is true.
- **One limit.** `LIMITS.escalationNotificationErrorMaxChars` replaces `NOTIFICATION_ERROR_MAX_CHARS` in the tools package and the literal `max(500)` in the `Escalation` schema.
- **Reschedule retry.** The repository answers a reschedule retry into the slot the appointment already holds as success. `RescheduleResult` has two `ok: true` variants told apart by `alreadyRescheduled` (decision r1/Q-1). Only the retry variant lacks `previous`, so the type rules out a retry that carries a previous time. `SAME_SLOT` and `RescheduleErrorReason` are gone. With them goes the handler's branch that re-read the appointment after `SAME_SLOT` and guarded against it having "vanished".

## Why we chose what we chose

Nick settled the open questions in the readiness review (r1 on #77) before work started, accepting each of its recommendations:

- **Retry shape (Q-1):** (a) two `ok: true` variants told apart by `alreadyRescheduled`, where only the move carries `previous`. The other option, (b), was one success shape with the flag and a nullable `previous`, which would have left a retry with a previous appointment, or a move without one, for tests alone to rule out. The review recommended (a) because the issue asked for a "retry variant", and because (a) makes the repository type enforce the same pairing the tool contract already enforces ("`previous_start_local` is null exactly when `already_rescheduled` is true").
- **The DynamoDB race (Q-2):** (a) only the up-front same-slot check returns the retry answer. A DynamoDB call that read the appointment before a concurrent move committed still gets `CONFLICT`, and the tool still answers `INTERNAL`, as on `main`. The other option, (b), was to re-read the appointment when the transaction is cancelled on its condition and answer the retry if it now holds the new slot, with a DynamoDB Local test of the race. The review recommended (a) because the issue said the tool's output is unchanged, and (b) changes the deployed tool's answer for a race, which fits better in its own issue. That issue is #207.
- **Established-patient tests (Q-3):** for each of book and reschedule, a case that passes only because of a `BOOKED` history, and a case where the only Brooks appointment is `CANCELLED` and the tool answers `NOT_ALLOWED`. The `CANCELLED` appointment comes from a test-local seed (`test/tools/established.ts`), so `clinic-default.ts` is unchanged.
- **The unreachable guard (Q-4):** the second `if (!provider)` guard in `get_my_appointments.ts` (the one inside `selected.map` that throws "Provider … was not loaded"; line 47 on `main` at `d0098c6`) stays. No input reaches it, because every provider the loop puts in the map was read and checked just above it. Its two Stryker mutants are equivalent.

The agent decided two things the spec left open:

- **The retry answer from the repository reuses the handler's existing `alreadyThere`.** That function reads the appointment's provider again rather than using the slot's provider that the handler already holds. The two are the same provider, since the appointment is in that slot, but reusing the existing path keeps the output identical by construction.
- **`startsAfter` takes a `Date`, not `Date | number`.** `reschedule_appointment` now keeps `now` as a `Date`. The union would have added a branch that only exists to save one `.getTime()`.

The agent also added a "Shared pieces" paragraph to the `add-agent-tool` skill. The PR review (264b4a4/SPEC-2) found that it presented `startsAfter` as every tool's "has this started?" rule, though `get_my_appointments`' "upcoming" filter counts a start equal to now as upcoming. Nick chose to keep the paragraph but limit it: `startsAfter` decides whether a slot or appointment can still be booked or moved, and the "upcoming" filter is a different rule at the boundary.

## What surprised us

Removing `SAME_SLOT` made the handler shorter in a way that is easy to miss. The "vanished after `SAME_SLOT`" guard existed only because the repository's failure value carried no appointment, so the handler had to read it again, and that read could in principle find nothing. Once the repository returns the appointment it already read, both the second read and its failure mode disappear. A Stryker survivor from the #93 review (TEST-2b, `spikes/stryker/results/at-555dfc5/mutate-93-review.txt`) tested exactly that guard. That code no longer exists.

## Evidence

- Seen failing: `npm run mutate` with DynamoDB Local up, so the contract suite ran against both repositories (decision A-9). 37 edits in two runs before the review (35 over every changed source file, then 2 for `handler.test.ts`, which the CI coverage gate asked for), all killed; after the review, 8 more for the tests it asked for (the status check before the retry answer in both repositories, the `Escalation` limit raised, removed and lowered, and the three provider guards), all killed. The tables are in PR #203.
- Eval: the L1 smoke suite on `sonnet-4.6` (`--suite smoke --mode l1 --trials 1`): `main` at `d0098c6` 8/8, pass@1 100%, tool-call accuracy 100%, 0 safety violations, $0.0567; this branch at `b5b5724` the same, $0.0570. The rows are in PR #203.

## What's next

- #207: answer the DynamoDB retry that loses the race to the first move as `already_rescheduled` (Q-2's option (b)).
