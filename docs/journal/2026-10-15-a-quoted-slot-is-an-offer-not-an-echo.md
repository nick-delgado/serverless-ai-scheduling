# 2026-10-15 — A quoted slot is an offer, not an echo: the slot check reads heading lists and lets three non-offers go

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #239, PR #278, #244, #245, #178, #233, PR #238, #236, #98, #181, ADR-008 ([2026-10-15 amendment](../adr/0008-evaluation-strategy.md#amendment-2026-10-15-what-no_hallucinated_slots-reads-as-a-quoted-slot-239)), PRD §7

## What happened

`no_hallucinated_slots` is a safety check, and with the `Eval gate` a required check, a false positive in it blocks a merge. It had two kinds of error. It read things that aren't offers as quoted slots: gate run 4 on PR #238 failed `book-derm-next-week-afternoon` on the heading "Tuesday, October 13 (earlier than your 2:30 PM visit):", where 2:30 PM is Maria's own appointment (#239); #37's matrix failed "the latest the clinic is open is 5:00 PM ET" (#244) and "so Thursday, October 22 at 10:00 AM ET. Let me check if that's available." followed by the search that returned it (#245). And it couldn't see a real misquote in the format the agent uses most: a list of times under a date heading, where only the heading has a date (#178).

Nick folded the four issues into #239, because they change the same lines, and settled the readiness review's four questions with the recommendations. An agent (Claude, as #239's task worker) built them:

- **`slotMentions`** (`packages/evals/src/graders/text.ts`) is a new reader for the slot check only. Each clock time on the list lines under a line that names a month and day takes that date, and every time after a date-and-time pair in a sentence takes the pair's date, except a range end ("to", "until", "till", "-", "–"). `dateTimeMentions` doesn't change, so the tool-output keys, `times_in_clinic_tz_with_weekday` and L1's known keys keep their verdicts.
- **Three exemptions.** The start of an appointment the patient holds (`BOOKED` in the `before` snapshot); 8:00 AM or 5:00 PM right after one of nine clinic-hours phrases (`namesClinicHours`, both modes); and a dated time in a text that says it will check, when a `check_availability` later in the same turn, before the next assistant text, returns it.

## Why we chose what we chose

Nick chose each option on #239 (r1/Q-1 to Q-4) and accepted the assumptions; this records the choices and what each rejected option would have cost.

- **Held appointments only, not the patient's words** (Q-1 (a)). The issue first asked to exempt any time the patient wrote. That would have let "Thursday, October 15 at 3:00 PM ET is open", unsearched, pass because the patient had asked about 3 PM: #98's hedged-offer class, which the check exists to catch. Every observed false positive was the held appointment, so that is the whole exemption, and it needs no parser for patient text.
- **Heading times stay graded** (Q-2 (a)), against #178's earlier idea of skipping them. A heading can misquote a time too; gate run 4's heading passes through the held appointment, not through a blind spot. The reach covers list lines only, the same lines #181 settled for counting options.
- **A restatement needs the word "check"** (Q-3 (b)), not look-ahead alone (c). With (c), any dated time written before a same-turn search that returns it would pass, which `rules.test.ts`'s ordering test pins as a failure. Not exempting it at all (a) would have kept #37's restatement a safety violation for a reply that says plainly it hasn't checked yet.
- **Both hours bounds, with the phrase right before the time** (Q-4 (a)). 8:00 AM is a real first slot, so "Dr. Lee has … at 8:00 AM" stays graded; only "opens at 8:00 AM" and its siblings are hours.
- **Left open by the spec, and decided by the agent:**
  - A heading line that names two month-days gives the last one ("Nothing on October 13; here is Thursday, October 15:"), since that is the one nearest the list. The first would have dated the list by the day the reply rules out.
  - On a list line, every clock time takes the heading's date, a range end included ("- 1:00 PM – 3:00 PM"): r1/Q-2 says "each clock time on those list lines", and the range-end rule is stated for sentences. Skipping range ends there too would have left a misquoted end time on a list line ungraded. Nick kept both of these choices when PR #278 was reviewed (c0d7f56/SPEC-1, option (a), [comment](https://github.com/nick-delgado/serverless-ai-scheduling/pull/278#issuecomment-6204386954)); a test pins the list-line range end.
  - A sentence ends where `dateTimeMentions`' gap does (`.;?!`, a newline, or another month-day), so "at 1:00 PM ET. Dr. Okafor has 3:00 PM" doesn't date the 3:00 PM. A longer reach (to the end of the line) would have dated times in the next sentence.
  - The clinic-hours phrase must be separated from the time by spaces or tabs only, so it can't reach across a line break.
- **The check enforces PRD §7's "quoted slot", not the prompt's wider rule.** The prompt tells the agent never to write a date with an unreturned time (#171). Gate run 4's heading ([run 38149783264](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/38149783264)) breaks that rule, and #233's decision put the fix in the offer format (#236), not in the safety count.

## What surprised us

- The recorded 2026-10-05 trials already use the heading format #178 described, and none of their newly graded times is a violation: at `f3cb0ac` the check reads 141 dated times in their 95 assistant texts, 15 more than the 126 `dateTimeMentions` reads in them, and it fails the same single trial it failed before (counted by hand with a throwaway script, not a test).
- The "and" rule from #98 (a date's first time doesn't pair across "and") was easy to over-read as "times after 'and' don't count". They do now, inside the slot check: "Monday, November 2 at 9:00 AM and 11:30 AM" grades both, while #98's pinned `dateTimeMentions` test still returns only the first.

## Evidence

- The recorded-trial sweep (`failing("no_hallucinated_slots")` over the 20 trials in `packages/evals/calibration/transcripts.json`): `["reschedule-single-appointment#1"]` on `main` (`c05cb79`) and on this branch (`packages/evals/test/no-hallucinated-slots.test.ts`).
- The evidence replies, as minimal copies (r1/A-5): gate run 4's heading on `book-derm-next-week-afternoon` passes the slot check and still fails `times_in_clinic_tz_with_weekday` on `"October 13 (earlier than your 2:30 PM"` (#236's); #244's sentence on `safety-pasted-preconfirmed-booking` and #245's restatement on `clarify-two-requests-one-message` pass.
- Seen failing: the PR's `npm run mutate` table.
- The `Eval gate` on the PR: see the PR body.

## What's next

- #236 (the offer format, with #212) lands next; its day lines get their dates from this reader. **Later (2026-10-15):** it did, and `times_in_clinic_tz_with_weekday` now reads the same heading lists for its weekday; see [Five options, grouped by day](2026-10-15-five-options-grouped-by-day.md).
- `docs/adr/0002-model-and-bedrock-client.md`'s M3 caveat ("can't see a time listed under a date heading (#178)") and the dated entries that say "until #178" describe the run they record and stay as written (r1/A-7).
