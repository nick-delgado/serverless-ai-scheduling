# 2026-10-15 — A split issue nearly closed early, so the PR body gets a check of its own

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #265, PR #266, #72, PR #252, PR #253, PR #254, PR #255, PR #258, PR #261, PR #262, PR #263, PR #241

## What happened

Process batch 10 (`improve-agent-process` over the first reviews of PRs #252 to #263) found four things. Missing tests doubled per 1,000 lines, and 8 of the 12 were in #262's E2E support code, which no gate read; the helpers under `scripts/test/` weren't gated either. Convention findings rose: PR titles copied from the issue (#253, #255), a second list of decisions in the PR body (#254, #258), and "the second PR, which closes #38" in #261's body, a closing keyword that would have closed a split issue at its first merge. #262's mutate tables described code a later commit had changed. And a body edit cancelled a running `Seen-failing evidence` run, so GitHub refused #258's merge on a cancelled required check.

An agent (Claude, as #265's task worker) built the ten approved items:

- **`PR body`**, a new non-required job in `pr-evidence.yml`, runs `scripts/pr-body.ts`. It fails a title that isn't `<type>(<scope>): <summary> (#<N>…)` (the scope optional, r1/Q-1), a body that says `Refs #N` and also has a closing keyword right before `#N` anywhere, code spans and comments included (r1/Q-4), and a list under "Decisions the spec left open" (r1/Q-6). All eight merged titles of the window pass; `[M3] …` doesn't.
- **The gates read the test helpers.** `vitest.config.ts`'s coverage globs add `scripts/test/*.ts` and `apps/*/e2e/**/*.ts`, less the Playwright specs (`*.e2e.ts` and `fr010.greeting.ts`, r1/Q-5). The evidence check narrows its extra exclusion from `**/test/**` to `**/src/test/**`, so only `apps/web/src/test/setup.ts`-style helpers stay exempt.
- **`--suggest` gains four kinds:** `pass-through` (a parameter of any enclosing function passed on, replaced by `undefined`), `flip-argument`, `extend-message` and `move-guard` (a discarded call swapped with the next statement).
- **A stale row doesn't count.** `pr-evidence.ts` reads each KILLED row's `find` back from the Change cell and counts the row only while that text still occurs in its file at HEAD. It prints every stale row.
- **`cancel-in-progress: false`** on `pr-evidence.yml`.
- The docs: `Refs #N` for a split issue's earlier parts, `expect` for Vitest commands only, an issue for each deferred item, and "makes stale" lists as where the search starts.

## Why we chose what we chose

The issue's "Decisions and clarifications" settled most of it. These are the decisions the spec left open, each with the alternative it beat.

- **What may follow the number in a title.** The `(#<N>…)` group may go on after a comma, semicolon or space (`(#38, part 1 of 2)`), and nothing else, so `(#38a)` fails. The alternative, any non-digit, let `(#38a)` pass.
- **The pad-space rule reads the File cell too.** One helper, `unspan`, reads both the File cell and the `find`, as the readiness review suggested, and A-2's rule (drop the pad space only beside a backtick, as `codeSpan` adds it) applies to both. One existing test row, written by hand as `` `` scripts/`x`.ts `` `` with pads `codeSpan` would never write, became `` ``scripts/`x`.ts`` ``. The alternative was CommonMark's rule (strip one space each side whenever both are there), which would misread a `find` that starts and ends with a space.
- **`move-guard` widens within its statement list, closing brace included.** `unique` widens right first, so when two blocks end alike the `find` takes the block's `}` before the statement in front. We kept the existing widening order rather than a special case.
- **A stale row is printed before the pass or fail line**, on every run, so a passing run still shows it.
- **The title types are a sync region.** `pr-body.ts`'s `TITLE_TYPES` and `task-workflow` step 3's branch types are marked `pr-title-types`, so changing one without the other needs a `Sync-checked` trailer. The alternative, a comment naming the source (A-9), drifts silently.
- **`pr-body.ts` takes no options**, so any argument exits 2 (A-8).

## What surprised us

- **GitHub's concurrency group holds one pending run by default.** A-11 asked us to check this before writing a claim. GitHub's workflow syntax page says that with `cancel-in-progress` off, a run queued behind a running one is `pending`, and that "by default, any existing `pending` job or workflow in the same concurrency group will be canceled and the new queued job or workflow will take its place" (`queue: single`). So the header and `CLAUDE.md` claim only that a body edit no longer cancels the running run, and that the new run waits for it. Two quick edits still cancel the first one's pending run. The same page documents a `queue: max` setting, which keeps up to 100 pending runs and can't be combined with `cancel-in-progress: true`. We didn't adopt it: the issue asked for `cancel-in-progress: false` only.
- **The new check failed this PR's own body first.** The mutate tables quote the failed tests' names, and one `it.each` name read "finds Refs #38 beside %s #38". Pasted into the body, those names put a `Refs` line and a closing keyword before the same number side by side, so the `PR body` check failed locally before we opened the PR, and GitHub would have linked #38 from them. The test now names no number (`1f197c8`). The rule reads the raw body, tables included (r1/Q-4 (a)), so a test name is body text too.
- **The suggester's new kinds found an old test's blind spot.** "widens a find by whole tokens" used two top-level calls, `f(a >= b);` and `g(a >= c);`, which `move-guard` now swaps. The test now filters that kind out; the `move-guard` tests cover it.
- **Most of what `--suggest` proposed on this branch was `pass-through`, and nine of those breaks can't fail.** At `8275523` it proposed 174 edits. The nine that survived all pass `undefined` for a TypeScript `SourceFile` argument to `getStart`, `getText` or a helper that hands it on; the compiler then reads the node's own file, so nothing changes. The first pass, at `e3c2fd0`, left other breaks standing too: a redundant lookahead, a `?? ""` nothing could reach, and tests that never put a list item on the line right after the heading. Those got tests or simpler code in `8275523`.

## Evidence

- Seen failing at `8275523`: 205 edits in four `npm run mutate -- … --markdown` tables (174 from `--suggest`, two left out as the CLI entry's `process.argv.slice(2)`, plus 33 by hand for the globs, the workflow and the patterns inside strings): 196 killed, 9 survived, all nine the equivalent `SourceFile` breaks above. The tables are in PR #265's body.
- GitHub Docs, "Workflow syntax for GitHub Actions", `concurrency` (read 2026-10-15).
- Merged titles checked: #252, #253, #254, #255, #258, #261, #262, #263 (`scripts/pr-body.test.ts`).

## What's next

- The batch record goes on #72, with whether the PR body check and the gated helpers cut the convention and missing-test findings in the next window.
- #257's PR (it owns `scripts/test/shell-harness.ts`) and #256's (`scripts/mutate.ts`) are the first to meet the widened globs and the stale-row rule.
