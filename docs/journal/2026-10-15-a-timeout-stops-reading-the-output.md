# 2026-10-15 — A timed-out mutate run stops reading the output instead of waiting for a process it can't kill

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** issue #268, PR #277, follow-up #276, #256 and the [earlier 2026-10-15](2026-10-15-an-empty-process-group-is-not-an-error.md) entry, #215

## What happened

`npm run mutate` runs each edit's test command in its own process group, and a timeout SIGKILLs that group. Since #256, a kill that finds the group empty no longer throws. But the run still ended only on the child's `close` event, which waits for the output pipes to close. A process that had left the group (setsid, a detached spawn) and still held the pipes kept the run going past `--timeout` until it exited, or until someone pressed Ctrl-C. #256's readiness review left that out of scope and Nick filed it as #268.

The fix is the one #256's review called option (b): right after the timeout's `stopRunning()`, `runCommand`'s timer destroys the child's stdout and stderr. `close` then comes as soon as the started process has exited. The edit reads TIMEOUT and is restored at the timeout. The escaped process is neither killed nor waited for, and it may still be running during the next edit's command. Whatever it prints after the kill is dropped. The `scripts/mutate.ts` header and `runCommand`'s doc now say so.

The agent (Claude, as #268's task worker) added two in-process tests:

- a command whose first process starts a grandchild in a session of its own, holding the output for 10 s, and exits. With `--timeout 3`, `main` must return with the TIMEOUT line and the file restored, `seconds` below 6 in the `--json` results, and the grandchild (its pid now written to `escaped.pid`) still alive;
- `sh -c 'echo $$ > sh.pid; node checker.cjs &'`: `sh` exits at once, and the backgrounded checker stays in its group, holding the output. The test waits until `sh` is gone while the checker runs, then checks that the timeout still killed the checker. Once the run stops reading the output at the timeout, `close` would come without the kill, so this test is what shows the kill still happens (#215 r1/A-3).

## Why we chose what we chose

The readiness review (r1 on #268) settled the open questions, and Nick accepted each recommendation:

- **Q-1: fix it, with the stream-destroy mechanism.** Rejected: (b) letting the agent decide against criteria, and (c) keeping the wait as documented behaviour. The destroy calls go in the timer's callback, not in `stopRunning()`, because the signal path exits the process anyway, and the direct-stop test expects the run to stay unsettled after `stopRunning()` (A-1). The run still settles only on `close` or `error`, never on the child's `exit` (A-2).
- **Q-2: an in-process test with a pid file for the grandchild,** rather than reworking the spawned-script test (which records no coverage) or timing alone (which can't show the process still runs).
- **Q-3: the `sh.pid` wait,** so the test can't pass without `sh` having exited before the kill.
- **A-5:** the runner prints nothing new when it leaves an escaped process running. The header is where a user learns it.
- **A-6:** the unedited run's check reads only the exit code, so a timed-out unedited run whose started process exited 0 passes it, now at the timeout. We left it as is and filed #276 for the owner to decide. **Later (2026-10-15):** Nick decided it fails the check; see [A timed-out unedited run is no baseline](2026-10-15-a-timed-out-unedited-run-is-no-baseline.md).
- **A-7:** a timed-out unedited run that fails prints its output, which now holds only what came before the timeout's kill. Neither the header nor this entry claims the destroy "loses nothing".

The spec left nothing else open. `--suggest` offered one edit, swapping the two destroy calls. Both run in the same synchronous callback, so the swap changes nothing (A-8), and it gets no row in the PR's table.

## What surprised us

- **Destroying our end of the pipes is enough for `close`.** Readiness assumption A-3 asked us to check this before writing the fix, since `close` waits for the stdio streams to end and another process still held their other ends. It does: once both streams are destroyed, `close` follows the started process's exit within a millisecond or two, while the escaped process is still alive. Without the destroy, `close` waited for the escaped process's exit, about 6 s later.
- **The check on the old code fails on an assertion, not on Vitest's timeout.** With both destroy calls removed, the new escaped-process test reads `expected 10.113 to be less than 6`: the run waited the grandchild's full 10 s, well inside Vitest's 20 s limit, as the review's timings intended.

## Evidence

- The A-3 check, run outside the checkout on Node 26.9.0 (local) and Node 24.22.0 (`npx node@24`; CI's Node is `.nvmrc`'s 24). A detached child's first process starts a grandchild with `detached: true, stdio: "inherit"` that lives 8 s, then hangs. At 2 s the script SIGKILLs the group and destroys stdout and stderr. On both versions, `exit` and `close` came at 2004–2010 ms with the grandchild alive. With the kill but no destroy, `close` came at 8063 ms (Node 24) and 8108 ms (Node 26), after the grandchild had exited.
- The fix: `4f1aa5a`.
- Seen failing: the PR's `npm run mutate` table. One edit drops `child.stdout.destroy()`, one drops `child.stderr.destroy()`, each naming the escaped-process test, and one drops the timer's `stopRunning();`, naming the `sh.pid` test.
- Spike cases (A-9): the fix inserts lines after `stopRunning();` and edits only comments elsewhere. Counting each `scripts/mutate.ts` case's `find` in `113-self.json` and `168-followup.json` at `06b5c21` (`main`) and at `4f1aa5a` (the fix), no count changed; `run-timeout-stop` and `kill-none-on-timeout` occur exactly once at both. No case reads REFUSED because of this change.

## What's next

- #276: decide whether a timed-out unedited run should fail the unedited-run check. **Later (2026-10-15):** Nick decided it fails the check; see [A timed-out unedited run is no baseline](2026-10-15-a-timed-out-unedited-run-is-no-baseline.md).
