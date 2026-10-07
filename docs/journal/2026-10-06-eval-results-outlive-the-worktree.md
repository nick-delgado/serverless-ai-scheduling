# 2026-10-06 — Eval results now outlive the worktree that ran them

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #195, PR #200, #72, #194, #179, #181

## What happened

A $0.31 rerun for #179 wrote its results into its worktree's `packages/evals/results/`, which is git-ignored, and removing the worktree after merge deleted them. When #181's readiness review needed trial 2's exact message, the file was gone, so #181's test pins a hand-built copy instead (incident 2 on #72). The only protection had been telling each worker to copy its results by hand.

The task-worker agent for #195 made the CLI keep a second copy. Every live run that finishes, `--replay` included, still writes `<timestamp>-<mode>-<suite>-<profile>.{json,md}` to `--out` (default `packages/evals/results/`), then writes the same pair to `$XDG_STATE_HOME/serverless-ai-scheduling/eval-results/<checkout directory name>/` (`~/.local/state/…` when `XDG_STATE_HOME` isn't an absolute path). `EVAL_RESULTS_COPY_DIR` replaces the directory above `<checkout directory name>`. The last line of a run names both `.json` paths. Nick settled the location, the per-checkout subdirectory, the failure handling, the refusal of a copy directory inside the repository and the single override in the readiness review (r1/Q-1 to Q-5 on #195).

The logic is in a new module, `packages/evals/src/results-copy.ts`, with its tests in `packages/evals/test/results-copy.test.ts`. `cli.ts` only passes in `process.env`, the home directory, its own checkout, the run's arguments and `console.error` for the warning, and prints the line that comes back. The real file calls are one adapter in `cli-args.ts`, `nodeFileWrites`, which the calibration step's files use too.

## Why we chose what we chose

These are the decisions the spec left open. The agent made each one; the PR is where Nick can overturn them.

- **A new module, not `cli-args.ts`.** A-4 suggested `cli-args.ts` and allowed a module beside it. `cli-args.ts` is already 470 lines covering argument parsing, setup, estimates and calibration, and the copy is one separate concern, so it got its own file and an `export *` line in `packages/evals/src/index.ts`.
- **A relative `EVAL_RESULTS_COPY_DIR` is a usage error (exit 2).** The other option was resolving it against the current directory. `npm run evals` and `npm run evals -w packages/evals` run from different directories, so the same value would point to two places. An empty value counts as unset, matching how `XDG_STATE_HOME` treats an empty value. Nick kept both after the PR review (d43a881/SPEC-3 (a)).
- **The containment check runs on a `--dry-run` too, but nothing is created.** Q-4 asks for the check before any model call. A dry run makes no model calls, but it's the run people try first (`CLAUDE.md` says so), so running the check there shows a bad override before money is spent. A-1 still holds: a dry run creates no directory. After the PR review, Nick chose to move that gate and the copy-failure warning out of `cli.ts`'s untested wiring (d43a881/TEST-1 (b)), and the agent moved them in `034146b`: `prepareResultsCopyDir` takes the run's `dryRun`, and the last-line function takes a required `warn` callback, so leaving the warning out of `cli.ts` is a type error. Calibration (`--export-calibration`, `--calibrate`) returns before the check, so a bad override can't break it, as A-6 keeps it out of scope.
- **Containment compares resolved paths, not real paths.** `path.resolve` removes `.` and `..` but doesn't follow symlinks. Following them would need the file system in a function Q-4 asks to keep pure, and a symlinked override back into the checkout is a deliberate act, not an accident. Nick kept this after the PR review (d43a881/SPEC-2 (a)): Q-4 targets accidental overrides.
- **The checkout comes from `cli.ts`'s own location** (`packages/evals/src/../../..`), as Q-2 says, and a parent directory named `.worktrees` adds the checkout that holds it as a second root. Finding the roots from that path is a pure function (`checkoutRoots`), so it's tested rather than left in `cli.ts`'s wiring.
- **A copy failure covers the copy's directory creation as well as its two files.** The directory is created before the run, but it can disappear in the meantime, so the copy write creates it again, and an error from that step is a warning too.
- **"Same path" is compared after `path.resolve`** on the two base paths, so `--out` pointing at the copy directory writes the pair once (A-2) even when spelled differently.
- **No ADR-008 amendment** (A-7): the primary location doesn't move. The second location is in `CLAUDE.md`'s Evals paragraph, `cli.ts`'s header, `results-copy.ts`'s header and this entry.

## What surprised us

The first version of the "copy write fails" test made the copy's parent directory read-only with `chmod`. That fails to fail when the tests run as root, which some CI containers do, so the test now puts a plain file where the copy's parent directory should be. `mkdir` returns `ENOTDIR` then whoever runs it.

The first mutation pass found two survivors. `rel === ""` in the containment check was redundant: the rest of the expression already returns true for the root itself, so the agent removed it. And no test told `resolve(copyBase) === resolve(primary)` from a plain string comparison, because `path.join` already normalises `..` and trailing slashes; only a relative `--out` needs the `resolve`, so the "written once" test now passes one.

The PR review found a hole in the containment check (d43a881/SPEC-1). The agent had checked the base directory, but the files land one level down, in `<base>/<checkout directory name>`. With the main checkout at `/r/repo`, `EVAL_RESULTS_COPY_DIR=/r` is not inside the repository, yet the copy directory it gives is `/r/repo`, the repository root. The parent folder of a clone is a natural answer to "a directory outside the repository", so this wasn't far-fetched. The check now runs on the directory the files go to, and its message names that directory. From a worktree the same override is still accepted, because the worktree's copy lands beside the checkout, at `/r/<worktree name>`.

## Evidence

- A-10 probe, run from the task-worker agent's shell before building on it: `mkdir -p ~/.local/state/serverless-ai-scheduling/eval-results`, writing and reading back one file there, then removing it, all succeeded (`XDG_STATE_HOME` unset).
- `npm run evals -- --dry-run`: prints the estimate, exits 0, and creates neither `packages/evals/results/` nor a checkout subdirectory under the copy directory. With `EVAL_RESULTS_COPY_DIR=<worktree>/x` it exits 2 naming the checkout; with `EVAL_RESULTS_COPY_DIR=rel` it exits 2 asking for an absolute path.
- The PR's mutation tables (`npm run mutate -- … --markdown`): 43 edits to `results-copy.ts` and the shared adapter in `cli-args.ts`, all KILLED by the tests each edit names in `packages/evals/test/results-copy.test.ts` or `packages/evals/test/calibration.test.ts`, and 6 to `cli.ts` and `index.ts` (dropping the new calls, the run's arguments, the `warn` callback and the export), all KILLED by `typecheck -w packages/evals` plus ESLint on `cli.ts`. After the review fixes, `npm run evals -- --dry-run` with `EVAL_RESULTS_COPY_DIR` set to the worktree's parent (`.worktrees`) exits 2 naming the worktree, and a dry run with a fresh `XDG_STATE_HOME` leaves it empty.
- No live eval ran: the tests cover the writes against a temp directory, as the issue's Verification says.

## What's next

- #34's eval gate decides whether CI keeps results by uploading them as an artifact; the CLI writes the copy in CI like anywhere else (A-8).
- `--calibrate`'s report still goes only to `--out`, so #159's live calibration run loses its report the same way if it runs in a worktree (A-6).
