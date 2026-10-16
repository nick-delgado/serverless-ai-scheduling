# 2026-10-16 — A lead-in that ends with the date is not a day line: three offer cases now want the day alone on its line

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #300, PR #303, #282 (PR #292), #236, #284, ADR-008, PRD FR-030, FR-035

## What happened

PR #292's live run of the four opted-in `l1-offer-*` cases passed `l1-offer-repeated-question` with "Dr. Priya Lee has these openings on Tuesday, October 13:" and then the times, with no separate day line ([that entry](2026-10-16-a-format-miss-is-not-a-leak.md), "What surprised us"). The case's only positive check, `contains_all: ["Tuesday, October 13:"]`, finds that string at the end of the lead-in just as well as on a line of its own. Nick filed #300 and settled it in its readiness review (round 1, every recommendation accepted): Q-1 (a), two non-safety patterns per day line in `format_must_match_none`, and Q-2 (a), the same check for `l1-offer-multi-day` and `l1-offer-broad-next-week-spread`.

An agent (Claude, as #300's task worker) built it. YAML and tests only, no grader change:

- Each day line gets `"\\S[^\\n]*<Weekday, October D>"` (anything that isn't a space before the date on its line) and `"<Weekday, October D>:[ \\t]*\\S"` (anything after the colon on its line). With the existing `contains_all`, the reply must have the day line, and every "Weekday, October D" in it must stand alone on its line. A miss is `l1.response.format_must_match_none`, `safety: false`.
- `l1-offer-repeated-question` gets the pair for Tuesday, October 13; `l1-offer-multi-day` for Tuesday and Wednesday, next to its two date-twice patterns; `l1-offer-broad-next-week-spread` for Monday, Tuesday and Wednesday. Each case's `notes` names the check and #300 (A-3).
- `l1-offer-single-day` keeps its date-twice pattern only. That file is #284's, and Q-2 (a) left it there. #284's own readiness review (Q-1 (a)) keeps a dated lead-in unacceptable, so the shape this check fails is the one #284 is fixing in the prompt (A-5). Until #284 adds the pair, though, that case fails a dated lead-in only when a day line repeats the date: it still passes the lead-in-only reply #300 was filed for. #284's own trials count that reply as a fail, and the case's grading has no check for it yet. The review of this PR found the gap had no owner, and Nick decided (`fd49963/SPEC-2`, (a), [comment](https://github.com/nick-delgado/serverless-ai-scheduling/pull/303#issuecomment-6224548008)) that #284 carries it: after its prompt fix, `l1-offer-single-day` gets the same two patterns, each with a failing row.
- `packages/evals/test/offer-format.test.ts` has a new describe for #300 (at `e008113`): a failing row for each pattern in each case, each asserting its exact failure list and zero safety violations, plus passing rows for the boundary replies the review listed, in all three cases. The existing rows that pass `TUE_LEE`, `TWO_DAYS` and `SPREAD` still pass unchanged.

## Why we chose what we chose

The check itself is Nick's (Q-1 (a), Q-2 (a)). The agent decided these points the spec left open:

- **Which reply each failing row builds.** For a case's first day, the "text before" row moves the date into the lead-in and drops the day line ("Here are some dermatology mornings on Tuesday, October 13:"), the shape PR #292's run saw. For a later day, it prefixes the day line ("And on Wednesday, October 14:"), because a lead-in can only end with the first date. In `l1-offer-multi-day` the lead-in-only shape matters: a dated lead-in next to a day line would also trip the case's date-twice pattern, so removing the new pattern wouldn't turn that row green, and the row couldn't show the pattern failing on its own. In `l1-offer-multi-day` and `l1-offer-broad-next-week-spread`, the "text after" rows move the day's first listed time onto its day line (`timeOnDayLine`), which keeps the reply otherwise in the format; the alternative, one handwritten reply per row, repeats the fixtures the file already has. `l1-offer-repeated-question`'s rows are handwritten instead: the lead-in-only reply and the times-on-the-day-line reply are the ones r1/A-1 names, and the tab row is the agent's variant of the second.
- **Tab rows.** The after-colon pattern allows spaces and tabs, so we added a failing reply with a tab between the colon and the times. Without it, dropping the tab from `[ \t]` changes no test's result. The first push had one, in `l1-offer-repeated-question`; the review of `fd49963` (TEST-1) found the same drop survived in the five copies in the other two cases, so each of their day lines now has one too. These rows are beyond the readiness review's list of rows (r1/Q-2's edges called that list complete), so the PR lists them as the agent's additions.
- **Passing rows for the readiness review's boundary replies**: a reply that opens with a day line, indented day lines, spaces after the colons, and CRLF line ends. Q-1's edges say option (a) passes all four. Pinning them is what lets a broader pattern (`\s*` for `[ \t]*`, `[\s\S]*` for `[^\n]*`, `.` or `[^\n]` for `\S`) be seen failing. At `e008113` we wrote them for `l1-offer-repeated-question` only, reasoning that the three cases share two pattern shapes. The review of `fd49963` (TEST-1) showed why that wasn't enough: a broadened copy in `l1-offer-multi-day` or `l1-offer-broad-next-week-spread` passed every row. They now run against all three cases (`editDayLines` applies one edit to each day line of `TWO_DAYS` or `SPREAD`).
- **Multi-day's list became a block list.** Six patterns on one flow line read badly; the two date-twice patterns are unchanged (at `e008113`).

## What surprised us

- **The weekday check isn't the gap, and stays as it is.** `times_in_clinic_tz_with_weekday` reads a list under any line with a weekday, a month and a day, so a dated lead-in works as a heading for it. That's #236 r2/Q-1 (a)'s reader, and #300's non-goals keep it: the case's own check closes the gap.
- **Nothing for `--suggest` to suggest.** `npm run mutate -- --suggest` returned 0 edits at `e008113`, since the change is YAML and a test file, which the coverage gate doesn't count as source. Every edit in the PR's table is handwritten: one per pattern per case that removes it, and, for `l1-offer-repeated-question`, one per regex part.

## Evidence

- The seen-failing table in PR #303 lists each edit, its `expect` and the test that went red. Its summary line, at `e008113`'s test file and case files, reads 23 edits, 23 killed, 0 killed other tests, 0 survived.
- `npm run lint && npm run typecheck && npm run test:coverage && npm run coverage:changed` passed locally on the branch (163 test files, 3971 tests, at `e008113`); `coverage:changed` had no added source line to check.
- No smoke case changed, so the smoke suite and `packages/evals/baselines/sonnet-4.6.json` stay the same. PR #303's `Eval gate` gives the numbers. We made no live run of the changed cases (optional in the issue, and skipped).

## What's next

- #284: the prompt side of the dated lead-in in `l1-offer-single-day`, and then, by Nick's decision on this PR (`fd49963/SPEC-2`), the same two day-line patterns for that case, each with a failing row, which closes its lead-in-only gap.
- #301: `book-derm-next-week-afternoon`'s `end_state.appointment` flake on recent gate runs.
