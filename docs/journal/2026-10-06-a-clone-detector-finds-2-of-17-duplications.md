# 2026-10-06 — A clone detector finds 2 of 17 reviewed duplications, so it reports and doesn't block

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #184, issue #72 (batch 6), PRs #161, #162, #165, #168, #172–#175, #179, #180

## What happened

Batch 6 of `improve-agent-process` came from the first reviews of ten PRs. Nick approved six changes (B6-1 to B6-6), and a task worker (Claude) built them in one PR. Under the skill's rules, a cause whose wording already failed gets a guardrail, a removal or an owner decision, not more wording. Five of the six follow that rule:

- **B6-1:** the ADR history test now keeps every existing italic pointer byte-identical. The old test stripped all pointers before comparing lines, so PR #175 could rewrite one in place.
- **B6-2 to B6-4:** three short corrections. Decisions the spec left open have one list, in the journal entry. An eval regression passes only when the owner accepted it on the issue. The cost of any live run beyond what was approved is stated first.
- **B6-5:** `npm run mutate` now takes an `expect` list and has a `--markdown` table. A new `Seen-failing evidence` check fails a PR whose body has no table naming each changed source file. The definition of done's list of things to break shrank to a pointer to the runner.
- **B6-6:** a duplicate-code check on the lines a branch adds. It ran into the issue's own stop condition.

Duplication was in 8 of the 10 reviews, 17 findings in all. Wording had failed twice, so the issue asked for `jscpd` in CI, with one condition. Before the check could block a PR, it had to flag about half of those 17 findings when run over each PR's reviewed head. It flags 2.

## Why we chose what we chose

These are the decisions the spec left open, each with the alternative it beat.

- **B6-1's reach.** PR #175's edit was in ADR-008's 2026-09-29 amendment, not in the decision body the old test checked. Two rules now apply. A body line must keep its own pointers, in order. Every pointer anywhere in the file, amendments included, must survive byte for byte. The issue's seen-failing case (re-apply PR #175's edit) only goes red with the second rule. The alternative was the body only, which would have passed #175's edit. Amendment text other than pointers can still change.
- **B6-1 forbids a link fix too.** Replaying the merges on `main` with the new rule fails two earlier ones. PR #124 corrected a pointer's anchor after an amendment heading changed, and PR #161 extended a pointer's text, which is the pattern B6-1 is meant to stop. The test passes on `main` itself, so the issue's stop condition doesn't apply. From now on, a broken anchor is fixed by keeping the heading, or by adding a new pointer.
- **What counts as a source file for B6-5.** We use the changed-line coverage gate's globs (`SOURCE_GLOBS`), not a second list. They cover `packages/*/src`, `services/*/src`, `apps/*/src` and `scripts/*.ts`, without tests and `.d.ts` files. Spikes fall outside them. A table names a file by its exact repo-relative path, because `npm run` runs `mutate` from the repo root. A suffix match would let `src/index.ts` stand for any package.
- **`KILLED-OTHER` exits 1, as `SURVIVED` does.** The edit didn't turn the test its author named red, so it isn't evidence. With a non-Vitest command no test names come back, so an edit with an `expect` list is always `KILLED-OTHER` there.
- **`--markdown` moves progress to stderr,** so stdout is only the table and the summary line, ready to paste. The alternative was a `--markdown <file>` option, like `--json`.
- **The evidence check is its own workflow.** It has to rerun when the PR body is edited, and `ci.yml`'s jobs don't need that trigger.
- **B6-6's threshold and status.** The check uses exact clones of at least 40 tokens and 3 lines, and runs in `Lint, typecheck, test` with `continue-on-error`. That makes it report-only until Nick decides. The alternatives were 30 tokens (the same 2 hits, 46 flags), renamed-identifier clones at 15 tokens (4 hits, about 1,150 flags), and making it blocking now.
- **The check's own findings were fixed, not fenced.** On this branch it flagged ten copies, mostly of `coverage-changed`'s CLI and test plumbing. We shared them instead: `scriptIo`, `noMergeBase` and `addedSince` are exported from `coverage-changed.ts`, and `scripts/test/git-repo.ts` serves four test files. The edit outside the owned paths is listed in the PR.
- **One clone was reordered, not shared.** It was four lines of "logs to the console by default" test idiom, which is the kind of false positive the calibration table counts.

## What surprised us

- **Duplication the reviews flag is mostly too small for a clone detector.** Of the 17 findings, the ones jscpd misses are a regex written twice, a type re-declared, a magic number, a hand-rolled argument parser and a cast pattern. Each is one to six lines. Batch 5 predicted this ("copies of one to four lines are too small for a clone detector"), and the calibration measured it.
- **The detector finds what reviewers skip.** It flagged 22 clones the reviews didn't raise. 18 of them are setup code repeated within one test file, 3 are test helpers copied across files, and 1 is the judge's retry loop. That loop was already a finding (SMELL-101 on #165) and was still there in #175. The noise is real duplication, just not the kind reviews ask agents to fix.
- **`expect` caught a test on its first run.** The `markdownTable` test had one KILLED row and one KILLED-OTHER row. When the summary counted KILLED in place of KILLED-OTHER, it still printed "1 killed, 1 killed other tests". The edit turned other tests red, so a plain run would have recorded it as KILLED. With `expect`, it came back as KILLED-OTHER, and a second KILLED row now tells the two counts apart. The same first pass found five more gaps in the evidence check's tests. One was a deleted file that git paired as a rename with an identical new test file, so `--diff-filter=d` was never exercised.
- **Refactoring with the check on is awkward.** Renaming calls across `coverage-changed.test.ts` turned old repeated test setup into "added lines", and those got flagged. Touching fewer lines (destructuring the helper into the old names) avoided it.

## Evidence

Calibration: the check on each PR's reviewed head against its base, `.jscpd.json` as committed (40 tokens, 3 lines, exact clones). A hit is a flagged clone that overlaps the finding's lines and whose other side is the copied source.

| PR | Reviewed head | Duplication findings | Hits | Flags | Flags that aren't findings |
|---|---|---|---|---|---|
| #161 | `2679864` | 0 | 0 | 4 | 4 (same test file) |
| #162 | `f13205f` | 1 (SMELL-1) | 0 | 1 | 1 (same test file) |
| #165 | `f6d8ff8` | 8 (SMELL-101 to -104, -201, -202, -207, -208) | 1 (SMELL-101) | 1 | 0 |
| #168 | `982c244` | 1 (SMELL-1) | 0 | 3 | 3 (2 same file, 1 across test files) |
| #172 | `0e2b405` | 0 | 0 | 0 | 0 |
| #173 | `dabc0f1` | 1 (SMELL-1) | 0 | 0 | 0 |
| #174 | `e9af688` | 1 (SMELL-1) | 0 | 10 | 10 (9 same file, 1 across test files) |
| #175 | `32474a5` | 2 (STD-2, SMELL-1) | 0 | 3 | 3 (the SMELL-101 copy again, 1 across test files, 1 same file) |
| #179 | `4a6f31c` | 1 (SMELL-1) | 0 | 1 | 1 (same test file) |
| #180 | `d57d91b` | 2 (SMELL-1, SMELL-2) | 1 (SMELL-1) | 1 | 0 |
| **Total** | | **17** | **2 (12%)** | **24** | **22** |

Sweep, with hits counted only when the other side is the copied source:

| Clones | Min tokens | Hits / 17 | Flags |
|---|---|---|---|
| exact | 10 | 7 | 813 |
| exact | 15 | 4 | 300 |
| exact | 20–40 | 2 | 147 → 19 |
| exact | 50 | 1 | 6 |
| renamed (`--ignore-identifiers --ignore-literals`) | 10 | 8 | 4,117 |
| renamed | 15 | 4 | 1,152 |
| renamed | 30 | 3 | 143 |

The sweep ran jscpd at 10 tokens and filtered the report. The committed threshold was confirmed by running `scripts/dup-changed.ts` itself on each reviewed head.

B6-1: replaying the merges on `main` with the new rule, `e19a06a` (PR #161, ADR-007) and `ef3d948` (PR #124, ADR-003) each lose a pointer. `5abf038` reverses #175's edit within its own PR. On `main` itself the test passes, and re-applying #175's edit turns `docs/adr/0008-evaluation-strategy.md` red. With the old test, the same edit passed all 12 tests.

## What's next

- Nick decides B6-6: keep it report-only, make it blocking at 40 tokens and accept about 2 flags per PR that a reviewer wouldn't raise, or drop it and leave duplication to review.
- If it stays, measure the hit rate again at the next batch, with the PRs written under it.
