# 2026-10-15 — A timed-out unedited run is no baseline, even when it exits 0

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** issue #276, PR #281, #268 and its [entry](2026-10-15-a-timeout-stops-reading-the-output.md), #256, #215

## What happened

`npm run mutate` runs the test command once unedited, and mutates nothing if that run fails. The check read only the exit code. A command whose started process exits 0 while something it started outlives `--timeout` passed it: before #268 once a process that had left the command's group exited, and since #268 at the timeout itself. Every edit was then judged against a run that never finished. #268's readiness review flagged it (r1/A-6), and Nick filed #276.

Nick decided yes: an unedited run that timed out fails the check whatever its exit code. `main` now checks the run's `timedOut` flag before its exit code. A timed-out unedited run prints `mutate: the unedited run timed out after <n> s (--timeout); nothing was mutated.`, then the output the command printed before the timeout, and exits 2 without applying an edit. Edited runs are unchanged: a timeout there is still TIMEOUT. The `scripts/mutate.ts` header now says so, and its exit-code list counts a timed-out unedited run under 2.

The agent (Claude, as #276's task worker) added one parametrised test in `scripts/mutate.test.ts` with two cases. In each, the process the runner starts exits 0 at once, and `--timeout` is 2 s:

- `sh -c 'echo printed before the timeout; echo $$ > sh.pid; node checker.cjs &'`: the hanging checker stays in sh's process group. The timeout kills it, and the after-each check confirms it's gone;
- #268's `ESCAPER`: its grandchild leaves the group and holds the output for 10 s.

Both cases expect exit 2, no output on stdout, the target file unchanged, the started process gone, and a message that says "timed out after 2 s" and never "failed". The first case also expects the line printed before the timeout in the message.

## Why we chose what we chose

The issue had no readiness review (Nick's choice), so where it was silent the agent took these readings:

- **The timeout check comes first, before the exit code.** A run the timeout killed directly ends with exit `null`, and used to read "failed (exit null)". It now reads "timed out" too. The decision says the message names the timeout "whatever its exit code", so the agent didn't keep the old message for a non-zero exit. The rejected alternative was a separate branch for `code === 0 && timedOut` only.
- **The message keeps the command's output,** as the failed-run message does, even though it ends at the timeout's kill (#268 r1/A-7). The header says so. Dropping the output would hide what the command was doing when it ran out of time. That's the first thing a user needs to raise `--timeout` or fix the command.
- **The message names the flag** (`--timeout`) next to the seconds, so the fix is in the error. Exit 2 is the existing code for a failed unedited run. A new exit code would have changed the header's contract for one case.
- **Two cases, not one.** The acceptance criterion names "a process left in its group (or one that left it)". The in-group case also shows the kill still reaches the checker when the unedited run times out. The escaped case is #268's fixture as it stands.

## Evidence

- The fix: `70034ad`; the test's output assertion: `8ff7369`.
- Seen failing: the PR's `npm run mutate` table. Each edit names the new test: dropping the `timedOut` guard, moving its `return 2` above the message, returning 0, printing the default timeout instead of `--timeout`'s value, dropping the output, and saying "failed".

## What's next

- Nothing filed. An escaped process that outlives the timeout is still neither killed nor tracked (#256, #268's non-goal).
