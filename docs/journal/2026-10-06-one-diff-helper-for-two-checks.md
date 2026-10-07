# 2026-10-06 — One diff helper for two PR checks, and a path limit that only a moved file can see

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #199, PR #204, PR #196, #194, #184

## What happened

`scripts/journal-links.ts` (#194, PR #196) copied its `git diff --name-only` call and its base rule (`--base`, else `PR_BASE`, else `origin/main`) from `scripts/pr-evidence.ts` (#184), and `npm run dup:changed` reported the copy on PR #196. Nick chose to share it in a follow-up rather than in that PR (`8c94697/SMELL-1` (c)), and settled the readiness questions on #199 before work started: remove the clones that hold the git call or the base rule (r1/Q-1 (b)), and make every break of the helper turn a test red, with each script's own suite red for the breaks of its own call (r1/Q-2 (a)).

An agent built it. `scripts/coverage-changed.ts`, where `scriptIo`, `DEFAULT_BASE` and `addedSince` already live, gained two helpers that both scripts call:

- `baseRef(flag, env)`: `--base`, else the environment value when it's non-empty, else `DEFAULT_BASE` (`||`, so an empty `PR_BASE` on a push run still counts as unset);
- `namesSince(git, base, filter, paths = [])`: `git -c core.quotePath=false diff --name-only <filter> <base>...HEAD -- <paths>`, empty lines dropped. It throws when git fails, and each script keeps its own "can't diff against <base>" message and exit 2 (A-3).

`pr-evidence.ts` calls `namesSince(git, base, "--diff-filter=d")`; `journal-links.ts` calls `namesSince(git, base, "--diff-filter=A", ["docs/journal/"])` and keeps its `isEntry` filter on the result. Each keeps its own `parseArgs` call and `usage:` message (A-1). The existing tests of both scripts are unchanged.

## Why we chose what we chose

- **`--` always, not only with paths.** `git diff … <base>...HEAD --` with no paths lists every path, so the helper passes the separator unconditionally instead of branching on an empty list. It also means git never reads a base or a path limit as the other. The review of `5d07e7f` noted that this changes git's wording inside `pr-evidence`'s exit-2 message for an unknown base (exit code and the script's own prefix unchanged); Nick kept it (`5d07e7f/SPEC-1` (a)).
- **The base rule is shared by the two PR checks only.** `coverage-changed.ts`'s own `main` (`COVERAGE_BASE`) stays unchanged, as the issue's owned paths say, and `dup-changed.ts` (`DUP_BASE`) isn't this issue's file. Both could call `baseRef` in a later change.
- **The test-setup clone stays** (`journal-links.test.ts` ↔ `pr-evidence.test.ts`, the `describe("main")` setup): sharing it would edit test bodies the issue keeps "unmodified, apart from imports" (A-2, confirmed by Nick).
- **The direct tests run against a repository whose `main` moves on after branching**, so a two-dot diff lists a file the merge-base diff doesn't. Without that, `...` → `..` would survive.

## What surprised us

- **The `docs/journal/` path limit was invisible to the existing tests.** `--diff-filter=A` and the `isEntry` filter already drop everything outside the journal, so dropping the path argument changed nothing they could see. What it does change is rename detection: git pairs files only within the pathspec, so an entry moved into `docs/journal/` from elsewhere is an add with the limit and a rename without it. That is the one case that tells them apart, so the new journal-links test moves a draft into the journal; the readiness review had named the case (r1/Q-2) before any code existed.
- **`isEntry` in `main` had no test either.** The mutation run left `.filter(isEntry)` → (nothing) SURVIVED: the only files it drops are an added non-`.md` file or a new index, and the fixture adds neither. A second new test adds a diagram under `docs/journal/`.

## Evidence

- `npm run mutate` with 19 edits (the helper's flags, filter, path limit, `--` separator, `...`, empty-line filter; the base rule's `||`, the `??` that keeps an empty `--base`, precedence and default; each script's filter, environment variable and base argument, and journal-links' path; `isEntry` in `main`), run against the three suites: 19 killed, 0 survived. The first run had `isEntry` SURVIVED before its test existed. The review of `5d07e7f` found three breaks with no row: dropping `--` and loosening the `??` on `--base` both survived (no test passed a path missing from the working tree, or an empty `--base`), and journal-links' base argument wasn't broken at all. Two new assertions and three rows cover them. The table is in the PR's body.
- `npm run dup:changed -- --base f0d019c` before: `journal-links.ts:38-44` ↔ `pr-evidence.ts:70-76` and the test-setup clone. After: the same two, the production one now `journal-links.ts:38-44` ↔ `pr-evidence.ts:71-77`, which is the `main` signature, the `scriptIo(deps)` line and `let base: string;` only; no clone covers the git diff call or the base rule (r1/Q-1 (b)).

## What's next

- Point `coverage-changed.ts`'s and `dup-changed.ts`'s base rules at `baseRef` when either file is next touched.
