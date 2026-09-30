# 2026-09-30 — A past date gets an error, not an empty list, so the agent can't call last Friday "fully booked"

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #19, PR #70, PRD FR-030; review findings SPEC-2 and STD-2a on PR #70

## What happened

`check_availability` takes a clinic-local `date_range` from the model. Issue #19 and the contract say nothing about dates before today, but a patient will say "anything last Friday?" and the model will pass it on. The task-worker agent that built the tool had to pick a behaviour, and it wrote the rule into the handler header (`packages/tools/src/tools/check_availability.ts`):

- Only slots that start strictly after `ctx.clock.now()` are offered.
- A range that is partly in the past is clamped to "from now". The model isn't told.
- A range that ended before today (clinic calendar) is `INVALID_INPUT`, with the current clinic time in the message and a hint to ask the patient for upcoming days.
- Today, with every remaining slot already started, is an ordinary empty success.

The agent recorded the choice in the handler and the PR body, but not in the journal. The PR review flagged that gap (STD-2a) and, separately, the fact that the spec was silent (SPEC-2). Nick weighed the options below and kept the agent's rule.

## Why we chose what we chose

The agent didn't write down the options it weighed, only the reason for its choice. Laid out now, they are:

| Option | For | Against |
|---|---|---|
| Empty success for any past range | Simplest; no new error path | `{ slots: [] }` reads as "nothing open". The model can tell the patient last Friday was fully booked, which is false and sounds authoritative. |
| `INVALID_INPUT` for any range that touches the past | One rule, never silent | "This week" asked on a Wednesday would fail and force a re-ask for a range that is mostly fine. |
| **Clamp a partly past range; reject a wholly past one (chosen)** | "This week" just works; "last Friday" gets an error whose hint tells the model what to do next | The clamp is silent: the model can't tell that Monday and Tuesday were skipped. |
| Clamp and tell the model (a note in the output) | Never silent | Needs a field in the contract's output schema (a cross-stream change), and an eval run to see whether models use it. |

The deciding argument was the first row: an empty list is an answer, and a wrong answer the model will state confidently. An error with a hint is a prompt to go back to the patient. It also hands the model the current clinic time, which helps because models get relative dates wrong. Our first L1 eval run had already produced "define next week" as a finding.

The costs Nick accepted: the clamp can hide a miscomputed range that is half in the past, and a weaker model may handle an error worse than an empty list (retrying the same dates, or escalating instead of re-asking). The evals will show whether that happens. The fourth row would remove the silent clamp, but it is a contracts change, so it waits for evidence that it's needed.

The reviews found three more places where the spec was silent. Nick applied the same principle to the first two, and filtered in the handler for the third:
- **Mismatched filters stay an error (first review, SPEC-3).** A `provider_id` whose specialty contradicts `specialty` returns an error, not an empty list. The mismatch usually means the patient or the model has the wrong doctor in mind, and an empty list would hide that.
- **A search with neither filter is now an error (first review, SPEC-4).** The agent had answered it with a clinic-wide list. On the test clock (Tue Oct 6), that list was five 8:00 AM slots, chosen by the alphabetical order of provider ids: a family doctor, a family doctor not taking new patients, a pediatrician, a cardiologist and a physical therapist. None of it reflected why the patient was coming in, and picking a specialty for the patient edges toward the medical advice ADR-009 rules out. The error's hint now tells the model to ask what kind of visit, or which provider.
- **Specialty searches leave out providers not taking new patients (second review, SPEC-2).** `SlotOption` has no acceptance flag, so a family-medicine search that included Dr. Brooks let the model offer him to a new patient with nothing to warn it. Nick chose the handler-only option over a contract change: a specialty search offers only providers accepting new patients, and a search for a provider by `provider_id` still returns their slots.

## What surprised us

The same review found that one of the tool's DST tests could never fail. "Keeps an EST day's range to exactly that clinic day (no spill from UTC midnight)" ran on the specialty path, where the repository does the day matching, not the handler's range conversion. Every fixture slot is between 8:00 AM and 5:00 PM ET, which is 12:00Z to 22:00Z. So a range built from UTC midnights returns exactly the same slots as the correct clinic-local one. We learned this lesson once already with the double-booking test (see [2026-09-29](2026-09-29-watch-the-double-booking-test-fail.md)): a test only counts once you've watched it fail. The replacement test seeds two slots next to clinic midnight on EST days: Fri Nov 6 at 7:30 PM ET (00:30Z) and Sat Nov 7 at 11:30 PM ET (04:30Z the next day). It fails when `clinicDateRangeUtc` is swapped for a UTC-day range.

The review also surfaced a conflict between the issue ("≤ 5 slots") and the contract (`LIMITS.availabilityMaxSlots: 10`). The agent had followed the contract. Nick chose 5, so the contract limit, the tool description and the tests now say 5.

## Evidence

- Rule and rationale: header of `packages/tools/src/tools/check_availability.ts`.
- Tests: "rejects a range that ended before today, with a hint to ask for upcoming days", "clamps a range that starts in the past to today", "takes today from the clinic calendar, not the UTC one", and "bounds a provider_id search by clinic midnights, not UTC ones" in `packages/tools/test/tools/check_availability.test.ts`.
- The other three rules: "rejects a provider_id that contradicts the specialty", "rejects a search with neither provider_id nor specialty, with a hint to ask the patient" and "leaves providers not accepting new patients out of a specialty search, but not a provider_id one", in the same file.
- Mutation checks run while fixing the review: a UTC-day range, a UTC "today", and `<` for `<=` in the early exit each fail exactly the test written for them.
- Review report and response: comments on PR #70.

## What's next

- Once the eval runner lands (#30), add the L1 case `l1-availability-past-dates` ("anything last Friday?" should get a clarifying reply, or a search starting today or later) and run it across the model profiles.
- Use that case to decide whether the description should say "dates must be today or later (clinic time)", the optional nit from PR #70.
