# 2026-10-06 — Three reviews asked for the same journal fix, so a test checks it now

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #194, #72, PR #188, PR #189, PR #191, PR #162, PR #165, PR #185

## What happened

Process batch 7 (`improve-agent-process`, after harness 2026.10.06.2) took the first reviews of PRs #188–#191. Two findings had come back after we had answered them with wording: a journal entry whose Chapter didn't match its milestone or its README row (#162 STD-1, #165 STD-1, then #191 STD-1; batch 6 deferred a check as B6-7 "until it recurs"), and a new entry whose Related line never got its PR number (#189 STD-2), although `task-workflow` step 7 asks for it. Under the skill's rule, wording that already failed gets a guardrail, not more wording. Nick approved three changes; an agent built them in #194:

- **B7-1, an owner decision (#188 `6a09806/STD-2` (b)).** An acceptance criterion that states a tolerance, such as FR-041's "no more than one case below", is the owner's acceptance of that regression, given in advance. `CLAUDE.md`'s definition of done and `task-worker.md` each gained one clause.
- **B7-2, `scripts/journal-index.test.ts`.** Every `docs/journal/YYYY-MM-DD-*.md` entry has a Chapter that is a row of the dev-journal skill's "Rolling up into the README" table (the test reads the table from the skill, so it stays the one source) and a Milestone that starts with that row's code; `docs/journal/README.md` has exactly one row per entry, with the same chapter, and every row's file exists.
- **B7-3, `scripts/journal-links.ts` and a "Journal links" job** in `pr-evidence.yml`. An entry the PR adds (`git diff --diff-filter=A <base>...HEAD -- docs/journal/`, less the index) must have `PR #<this PR>` on its Related line. It needs the PR's number, so it is red on every PR's first push until the "link PR #N" commit. It isn't a required check; that's Nick's call. This entry is its first customer.

## Why we chose what we chose

The decisions the spec left open, each with what it beat:

- **An added entry with no Related line fails**, the same as one whose line lacks the link. The spec named only the second case; passing the first would let an entry dodge the check by dropping the line the template asks for.
- **A renamed entry isn't "added".** We kept git's default rename detection with `--diff-filter=A`, as the issue wrote the command, rather than `--no-renames`, which would make renaming an old entry demand a link to a PR that didn't write it.
- **`PR #42` doesn't match `PR #420` or `XPR #42`.** A plain substring test would have passed PR #194's link for PR #19.
- **The journal-index helpers live in the test file**, as `scripts/adr-history.test.ts` does, with synthetic cases for each failure the issue lists beside the check over the real repo. A separate module would have added a source file with nothing to run it but the test.
- **`CLAUDE.md` now says "all four are green"**, counting Journal links, though branch protection still lists three: a PR whose entry lacks its link isn't done either way.

## What surprised us

- The new chapter test failed on `main` on exactly one of the 49 entries then on `main`, the one the issue had found by hand: #98's entry (milestone M2) said chapter 5. It is chapter 4 now, in the entry and its README row. Seven other entries say chapter 5 with M3 and pass.
- Our first fixture for the link check passed a new entry it should have failed. The branch deleted an old entry and added a new one built from the same template, and git paired the two as a rename, so `--diff-filter=A` never saw the new file. Real entries are rarely that alike, but the fixture now deletes a file that looks nothing like an entry.

## Evidence

- `npm run --silent mutate -- edits.json --markdown -- npx vitest run scripts/journal-`: 20 edits, 20 killed, each by the test its `expect` names (the table is in the PR body). The issue's own breaks are among them: #191's entry set to chapter 4 with M3, its README row dropped, its Chapter line dropped, and its row pointed at a missing file.
- Before the fix, the repo check printed one problem: `2026-10-05-a-refusal-that-quotes-a-time-is-not-an-offer.md: milestone "M2" doesn't start with M3, chapter "5. What the evals showed"'s`.

## What's next

- Nick decides whether "Journal links" joins the required checks.
- Batch 7's record goes on #72 with the outcomes of these guardrails at the next checkpoint.
