# 2026-10-15 — A timed-out unedited run is no baseline, even when it exits 0

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** issue #276, PR #281, #268 and its [entry](2026-10-15-a-timeout-stops-reading-the-output.md), #256, #215

## What happened

`npm run mutate` runs the test command once unedited, and mutates nothing if that run fails. The check read only the exit code. A command whose started process exits 0 while something it started outlives `--timeout` passed it: before #268 once a process that had left the command's group exited, and since #268 at the timeout itself. Every edit was then judged against a run that never finished. #268's readiness review flagged it (r1/A-6), and Nick filed #276.

Nick decided yes: an unedited run that timed out fails the check whatever its exit code. `main` now checks the run's `timedOut` flag before its exit code. A timed-out unedited run prints `mutate: the unedited run timed out after <n> s (--timeout); nothing was mutated.`, then the output the command printed before the timeout, and exits 2 without applying an edit. Edited runs are unchanged: a timeout there is still TIMEOUT. The `scripts/mutate.ts` header now says so, and its exit-code list counts a timed-out unedited run under 2.

The agent (Claude, as #276's task worker) added one parametrised test in `scripts/mutate.test.ts` with two cases. In each, the process the runner starts exits 0 at once, and `--timeout` is 3 s:

- `sh -c 'echo printed before the timeout; echo $$ > sh.pid; node checker.cjs &'`: the hanging checker stays in sh's process group. The timeout kills it, and the after-each check confirms it's gone;
- #268's `ESCAPER`: its grandchild leaves the group and holds the output for 10 s.

Each case first waits, for up to 2.5 s and so before the kill, until the started process is gone: the run's exit code is 0. Then it expects exit 2, no output on stdout, the target file unchanged, and the whole message on stderr: `mutate: the unedited run timed out after 3 s (--timeout); nothing was mutated.`, followed by the line printed before the timeout in the first case and by nothing in the second.

The PR's review (on `675c6c6`) found that the test left the other half of "whatever its exit code" unchecked. A second test runs the hanging checker itself with `--timeout 1`, so the timeout kills the started process and the run ends with exit `null`. It expects the "timed out after 1 s" message, exit 2 and no edit. Without it, narrowing the guard to exit 0, or moving it below the exit-code check, passed every test. The review also had the first test wait for the started process before the kill, as #268's `sh.pid` test does, rather than check its pid after the run, when the kill would have ended it anyway.

## Why we chose what we chose

The issue had no readiness review (Nick's choice), so where it was silent the agent took these readings:

- **The timeout check comes first, before the exit code.** A run the timeout killed directly ends with exit `null`, and used to read "failed (exit null)". It now reads "timed out" too. The decision says the message names the timeout "whatever its exit code", so the agent didn't keep the old message for a non-zero exit. The rejected alternative was a separate branch for `code === 0 && timedOut` only.
- **The message keeps the command's output,** as the failed-run message does, even though it ends at the timeout's kill (#268 r1/A-7). The header says so. Dropping the output would hide what the command was doing when it ran out of time. That's the first thing a user needs to raise `--timeout` or fix the command.
- **The message names the flag** (`--timeout`) next to the seconds, so the fix is in the error. Exit 2 is the existing code for a failed unedited run. A new exit code would have changed the header's contract for one case.
- **Two cases, not one.** The acceptance criterion names "a process left in its group (or one that left it)". The in-group case also shows the kill still reaches the checker when the unedited run times out. The escaped case is #268's fixture as it stands.

## Evidence

- The fix: `70034ad`; the test's output assertion: `8ff7369`; the review round's tests: `c3c8ce8`.
- Seen failing: the PR's `npm run mutate` table. Each edit's `expect` names the tests above: dropping the `timedOut` guard, narrowing it to exit 0, moving it below the exit-code check, moving its `return 2` above the message, returning 0, printing the default timeout instead of `--timeout`'s value, dropping the output, dropping "(--timeout)" or "nothing was mutated", and saying "failed". One more edit keeps `sh` alive until the kill (an EXIT trap that sleeps), and the first case fails on its wait.

## What's next

- Nothing filed. An escaped process that outlives the timeout is still neither killed nor tracked (#256, #268's non-goal).
