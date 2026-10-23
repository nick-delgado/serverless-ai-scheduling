# 2026-10-22 — The README tells chapters 3 to 6 in 21 beats, quotes the v15 exit table in six rows, and carries no matrix table

**Chapter:** 6. What I'd do next
**Milestone:** M4
**Related:** #43, PR #377, #44, #45, #345, #360, #361, ADR-002 (amendment of 2026-10-20), PRD §7

## What happened

#43 finished the README. Chapters 3 to 6 were placeholders ("*Coming in M1.*" and its two siblings), the status line still said "Phase 0 complete", and the architecture was an ASCII block in `docs/architecture.md`. By 2026-10-22 the journal held 130 entries tagged for those four chapters, so the first job was choosing. The task worker (Claude) posted its selection on the issue before writing any prose, 21 beats in all: four for chapter 3, six for chapter 4, six for chapter 5 and five for chapter 6, each naming the entries it draws on. Nick replied "ok" to all four chapters with no changes (r1/Q-1 (a)), and the chapters are written to that selection, in that order.

Each chapter is one narrative, as the `dev-journal` skill asks: a tension, what we tried, a result. Each beat is a paragraph that leads into the next, with links where a beat relies on an entry. Beyond the chapters the PR:

- puts a six-row eval table in chapter 5, with its link to ADR-002's 2026-10-20 amendment and one line saying #360 and #361 changed two graders since that run (r1/Q-2 (c));
- adds `docs/assets/architecture.svg`, hand-written, which replaces the ASCII block in `docs/architecture.md` and is embedded in the README (r1/Q-3 (a));
- rewrites the status line, chapter 2's "evals pick the model" bullet and its "nine decisions" count, `docs/architecture.md`'s first paragraph, and the appendix's runbook link (A-4, A-5, A-10, E-3);
- adds `**Later (2026-10-22):**` pointers to the eight lines in six journal entries that called #43's work pending (A-11, E-4).

## Why we chose what we chose

The settled decisions are on #43 (r1/Q-1 to Q-3, A-1 to A-11). These are the ones the task worker made where the spec was silent, each with the alternative it beat:

- **The note under the table is a quoted line, not a paragraph.** Chapter 5 has six beats, so six paragraphs, and the criterion allows at most six. The ADR link and the "since that run" line sit in a blockquote directly under the table, as its caption. The alternative, a seventh paragraph, would have broken the count the grep-style reading of the criterion checks.
- **Chapters 3 to 5 each end with one "→ Full entry" line,** the form chapters 1 and 6 use, naming the entry that carries most of the chapter: the model-catalog entry (chapter 3), the loop entry (chapter 4) and the exit re-run entry (chapter 5). Chapter 2 links its ADRs in the prose instead. The alternative, no closing link and links only in the prose, would have left chapters 3 to 5 unlike chapters 1 and 6.
- **The status line is dated "as of 2026-10-23",** not "as of the merge", which the text can't know. The worker wrote 2026-10-22, the day the chapters were written; Nick moved it to 2026-10-23, the day the PR opened. `gh` showed #43 as the only open M4 issue (A-5's check), so it says M0 through M4 are complete. If #43 merges later, the date is the part to touch.
- **The table's row labels keep the ADR's wording.** The safety cell is the ADR's text word for word, "one case, two trials, `clarify-voice-garbled-provider`, a restatement that omits the reason the patient gives with the yes", so a bare "4" can't read as four data leaks. The alternative, a shorter paraphrase, would have been one more place for the README and the ADR to drift apart.
- **Re-measured figures sit beside their successors in the same paragraph (A-3).** Chapter 5 gives 92% beside 86%, first text 4,735 ms beside 2,478 ms and 42 of 49 beside 47 of 47. Chapter 6 repeats the judge pair in one clause, `judge.v1`'s 86% beside `judge.v2`'s 47 of 47, and names #37's exit table as the one that met the targets on `system.v3`, so it doesn't contradict chapter 5. It leaves out the rubric average (4.89, then 4.77 and 4.79), which no beat needs.
- **The diagram draws RequestAccessFn's and ExpireFn's Cognito work in their box text, not as a Cognito User Pool box.** The edge list the decision gives has the authorizer, not a user pool; the pool is named in the API Gateway box and the two functions say what they do to it. A separate box would have meant more arrows for a detail the text already carries.
- **Chapter 6 says #360 and #361 are done,** because `gh` shows both closed, and that no run since has re-measured the table, which is the cost entry's own statement. The roadmap is the cost entry's eight items, grouped, with open issues linked by number.
- **Pointers go at the end of the stale line,** not in an entry's header, each pointing to this entry. The exit-rerun entry's pointer says the README quotes six rows, five of them from that entry's table and the first-text row from #251's measurement, because the line it follows says the README quotes "this table".

## What surprised us

- **The approved selection's shorthand was looser than its sources in two places.** It said v1 passed "all 66 trials of three runs", where the entry has one three-trial run (22 cases by 3 trials), and the matrix beat's "six profiles at 10 requests a minute" holds only for the two Claude profiles. We wrote to the entries and the ADR, since the task was to quote each figure exactly as its source gives it.
- **A figure's "later" was easy to lose.** Chapter 5 quotes the matrix's 92% task success and the exit run's 86%, 4,735 ms and 2,478 ms, 42 of 49 and 47 of 47. Each pair is in one paragraph, because a reader who finds only the first would take a superseded number for the result.
- **The table's last row is from another run.** NFR-001's 2,478 ms comes from #251's measurement on `system.v14` on 2026-10-19 and 2026-10-20, not from the exit run on `system.v15`. The row's label says so, as r1/Q-2 (c) requires; without it the table reads as one run.

## Evidence

- `git grep -nE 'Coming in M[0-9]|coming with M[0-9]' -- README.md` prints nothing; on `main` at `c0df3b9` it printed lines 51, 55, 59 and 93.
- Chapters 3 to 6 have 4, 6, 6 and 5 prose paragraphs; chapter 6's "→ Full entry" line stays last and isn't counted.
- The table's six values were compared with `docs/adr/0002-model-and-bedrock-client.md` lines 271 to 277 and the NFR-001 figure with line 259; the targets with `docs/PRD.md` §7.
- The SVG parses as XML, its labels are `<text>` and its background is an opaque white `rect`; it was rendered once in headless Chromium to check that no label overflows its box. GitHub's own rendering is checked by hand on the pushed branch.
- No eval or AWS call was made, and no dependency was added.

## What's next

- Nick checks the diagram on the PR branch's file view in GitHub, light and dark.
- The README's table stays at the 2026-10-20 numbers until someone re-runs the exit table on a prompt and graders that include #360 and #361 (the roadmap's first items).
