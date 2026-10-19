# 2026-10-11 — The chat bubble shows plain text, so the prompt now asks for it, and two checks hold it there

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #233, PR #238, #36 (PR #235), #230 (PR #237), #212, #236, #37, ADR-008, ADR-009, PRD FR-030–FR-034, PRD §5

## What happened

#36's `dev` run-through passed every check, but the replies the chat bubble would show had two flaws. The booking confirmation came back as `- **Provider:** Dr. Priya Lee (Dermatology)`, and the bubble renders text with `white-space: pre-wrap` and no Markdown renderer, so a patient sees the asterisks. And text the model writes before a tool call streams into the same bubble as the answer, so the escalation read "I'll connect you with our front desk right away, Maria." and then the handoff line again.

An agent (Claude, as #233's task worker) made three edits to the system prompt and bumped it to `system.v3` by `git mv`, as #230 did:

- Rule 5 now says the reply goes to a chat that shows plain text: no Markdown, no asterisks or underscores for emphasis, no `#` headings, and options one per line, starting with "- " or a number.
- The "never say you will check" rule now starts by saying the patient sees everything, including text before a tool call: write nothing there, or one short line the answer doesn't repeat (r1/A-4).
- The escalation paragraph gives the handoff line once in that reply, with nothing before the call that announces it (r1/A-6). `ESCALATION_MESSAGE` keeps its wording.

Nick settled the eval side on the issue (readiness round 1). Two non-safety invariants join ADR-008's core set (Q-1 (a)), so every scenario runs them, and `no_markdown` also runs on every L1 case. `no_markdown` flags bold, italics and headings (Q-2 (b)). `no_repeated_handoff` fails an escalation turn whose replies say "connect you with our (or the) front desk", or give the phone number, more than once (Q-3 (a)). A new L1 case, `l1-book-confirmed-plain-text`, asks for the first-time booking confirmation that came back bolded on `dev` (A-9). It isn't tagged `smoke`, and the baselines don't change (A-7).

## Why we chose what we chose

The issue settled the rules. These choices are the agent's, made where the spec left the details open:

- **The plain-text rule went into rule 5, not "# Style".** Rule 5 already said the reply goes to the patient as written, so formatting sits next to it among the rules the prompt says are never broken. The readiness review's risk note was that the prompt is itself written with `#` headings and `- ` bullets, and models mirror their prompt's format, so the rule had to be explicit rather than a style hint.
- **The matcher reads one line at a time and doesn't cut the list prefix.** The readiness review's reuse item, accepted with the round's answers, said to cut `LIST_ITEM_PREFIX` before matching, so this departs from it; the PR says so under "Departs from or questions an owner decision". The italics pattern already can't open on a `* ` bullet (its opening `*` must have no space after it), so cutting the prefix changed nothing a test could see, and `npm run mutate` would have left it standing. We dropped it, and tests pin that `* `, `- `, `1.` and `1)` lines never match. Splitting into lines also made the patterns' own newline exclusions redundant, so a mutant that removed them survived; we removed them and pinned "a pair split across lines is never flagged" instead.
- **The coverage table gets one new row, for the handoff given once in an escalation turn.** It names the four scenarios whose recorded `system.v1` trials doubled the handoff: three escalation scenarios and `reschedule-into-est-after-dst`. `no_repeated_handoff` runs on every scenario, as a core check; these four are where it has failed on record. No row claims the rule about text before a tool call: nothing checks it beyond the handoff, and narration in general (a "Let me look that up" line before a search) has no eval check, as A-4 says. (The row first said "Before a tool call: one short line at most", which the review of `3a88282` found claimed more than any check covers.)
- **The new L1 case declares its appointment under `setup`.** L1 runs no tool, but the fixture lint requires every `appt_…` ID in a case to exist, so the case declares the booked appointment, as `l1-book-already-booked-confirms` does.

## What surprised us

On recorded `system.v1` replies the checks fire much more than the issue's two examples suggested. `no_markdown` fails 11 of the 20 recorded trials in `packages/evals/calibration/transcripts.json`, in booking confirmations, offers, clarifications and handoffs, and one of them (`reschedule-single-appointment#1`) has only a single-asterisk italic. `no_repeated_handoff` fails 4: every doubled handoff on record is a paraphrase before the call ("Let me connect you with our front desk staff right now.") followed by the message after it, so a check on the exact message would never have fired. **Later (2026-10-19):** #296 moved these trials to `packages/evals/test/fixtures/system-v1/transcripts.json`; `packages/evals/calibration/transcripts.json` now holds the `system.v13` set; see [the #296 entry](2026-10-19-judge-v2-agrees-with-nick-on-47-of-47-on-system-v13-replies.md).

On `system.v3`, Sonnet 4.6 wrote no Markdown in any reply we ran: the 8 L1 smoke cases, 3 trials of the new L1 case and the 8 smoke scenarios. The escalation scenario gave the handoff once, with no text before the call. The five L1 smoke cases that end in a tool call came back with no text at all beside the call. The model still uses lists, as plain `1.` and `- ` lines, and its booking restatement became a `- Provider: …` list without the asterisks, which the prompt allows.

Our local scenario smoke run had one regression, and it isn't about formatting. `book-derm-next-week-afternoon` failed `max_five_options`: after the patient asked for "later slots on Thursday, or anything after 1pm on Tuesday with a different doctor", the reply listed five Tuesday times and two Thursday lines, seven times in one message. CI's Eval gate on PR #238 ran it again: on `8d0f526` it passed all 8 scenarios; on `0528586` it failed the same case on a different check, `times_in_clinic_tz_with_weekday` ("October 15 slots from 1:00 PM" has no weekday or ET); on `3a88282` it passed all 8 again. In those four k=1 trials on `system.v3` (ours and the gate's three), the case failed twice, each time on an older check, never on a plain-text check. Option counts are #212's, and ADR-008's gate tolerates one regression per mode, which Nick accepted in advance for this issue (r1/A-8). Four k=1 trials don't tell us whether the new list rule made these slips more likely; #37's k=3 runs on `system.v3` will.

## Evidence

All live runs were on 2026-10-11, on `sonnet-4.6` with `system.v3`, from this branch: the first three locally, the gate runs in CI, each named by the commit it ran on.

| Run | Result | Cost |
|---|---|---|
| L1 `l1-book-confirmed-plain-text`, k=3 | 3/3 pass, 0 safety violations | $0.0369 |
| L1 smoke, k=1 | 8/8 pass, 0 safety violations, 0 regressions | $0.0417 |
| Scenario smoke, k=1 | 7/8 pass, 0 safety violations, 1 regression (`book-derm-next-week-afternoon`, `max_five_options`) | $0.3103 + judge $0.0391 |
| Eval gate 1 (CI, `8d0f526`), both smoke modes, k=1 | pass: L1 8/8, scenario 8/8, 0 regressions, 0 safety violations | $0.0599 + $0.3365 + judge $0.0430 |
| Eval gate 2 (CI, `0528586`), both smoke modes, k=1 | pass: L1 8/8, scenario 7/8, 1 regression (`book-derm-next-week-afternoon`, `times_in_clinic_tz_with_weekday`), 0 safety violations | $0.0416 + $0.3513 + judge $0.0499 |
| Eval gate 3 (CI, `3a88282`), both smoke modes, k=1 | pass: L1 8/8, scenario 8/8, 0 regressions, 0 safety violations | $0.0417 + $0.3024 + judge $0.0331 |

- On `dev`, after `scripts/deploy.sh api dev` from this branch, as demo patient Maria Santos: the booking confirmation came back as "You're all set, Maria! Your appointment with Dr. Priya Lee is booked for Monday, October 12, 2026 at 12:30 PM ET at 400 Cedar Ridge Pkwy. Is there anything else I can help you with?", and a request for a person as "I'll connect you with our front desk. Please call 1-800-555-0199 (Mon–Fri, 8 AM–5 PM ET). I've passed a summary of our conversation to them.", with no text before either tool call, no asterisks and one handoff line.
- The fix round after the review of `3a88282` pushed once more, and CI's Eval gate ran on that commit too. This entry is part of that commit and can't name it, so that run's result and cost are in PR #238's description, not here.
- The local gate verdict on our two local smoke files: pass, with "prompt version system.v3, baseline system.v1" warnings in both modes.
- The new L1 case's reply, three times: "You're all set, Aisha! Your appointment with Dr. Priya Lee is booked for Wednesday, October 14, 2026 at 3:00 PM ET at 400 Cedar Ridge Pkwy." and a closing line.
- Offline, on the recorded `system.v1` trials (`packages/evals/test/plain-text.test.ts`): `no_markdown` fails 11 of 20, including `book-derm-next-week-afternoon#1` ("**Tuesday, October 13**") and `reschedule-single-appointment#1` (the italic); `no_repeated_handoff` fails `escalate-explicit-human-request#1` turn 1, `escalate-frustration#1` turn 3, `escalate-repeated-failure#1` turn 4 and `reschedule-into-est-after-dst#1` turn 4.
- `npm run mutate`: 36 edits to the prompt, its index, the harness default, the matchers, the invariants, the L1 check and the schema, all 36 killed (the PR's table). Six of them came with the fixes after the review of `3a88282`: the `escalate_to_human` name condition, both italics lookarounds, the heading's space, the handoff phrase's flags, and the prompt's handoff wording. The first run left one survivor and one killed-other (T7, T6), which became two new test cases and a simpler pattern.

## What's next

- #37 re-records the baselines on `system.v3`. Until then, every gated PR's Eval gate warns that the prompt version differs from the baseline's `system.v1`.
- #212, #234 and #236 edit `system.v3.ts` now, and whichever merges next takes `system.v4`. **Later (2026-10-15):** #236 (with #212) took `system.v4`; see [Five options, grouped by day](2026-10-15-five-options-grouped-by-day.md).
- #236's day lines ("Monday, October 12:") pass `no_markdown`, as Q-2 intended.
