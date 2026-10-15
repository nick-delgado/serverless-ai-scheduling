# 2026-10-15 — An empty process group isn't an error, and Vitest won't fail a test for a throw in a timer

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** issue #256, PR #269, follow-up #268, #215 / PR #254, #184, the [2026-10-13](2026-10-13-an-empty-pid-file-is-pid-zero.md) entry

## What happened

`npm run mutate` writes one edit, runs the test command, and restores the file in a `finally`. A timeout or a SIGINT/SIGTERM first calls `stopRunning()`, which SIGKILLs the command's whole process group. That kill had no `try`. When the group was already empty, it threw `ESRCH`, and `running` was still set because it's cleared only on the child's `close`, which waits for the output pipes. That happens when a process from the command leaves the group (setsid, a detached spawn) and keeps the output open after the group's last member has exited. The throw was uncaught inside the timer's callback, so the runner died before the `finally` could restore anything. In the signal handler, it skipped the restore and the exit code 130. Either way, the source file stayed mutated. The review of PR #254 found this (`d4b0027/STD-4`), and Nick filed it as #256.

The agent put the kill in a `try` that ignores any error, and moved the report directory's removal after it, so it runs whatever the kill did. The timer callback and the signal handler didn't change. The header now says that a process that left the group isn't killed and that the run waits for it to close the output.

The tests needed a real empty group, so the agent added a stand-in command whose first process starts a grandchild in a session of its own (`spawn(..., { detached: true, stdio: "inherit" })`), writes its pid and exits. The grandchild holds the output pipes for a few seconds, then exits on its own. Nothing ever signals it. Three new tests use it or a spy:

- in-process, the test waits until the first process has written a whole pid and is gone, then calls `stopRunning()` directly: it must not throw and must remove the report directory before the run settles;
- in-process, a `process.kill` spy throws `EPERM`: `stopRunning()` must not throw, and still removes the directory;
- a spawned script with `--timeout 3` on the same command: it must print the TIMEOUT line, exit 0 and leave `target.txt` restored. Before the fix, the script died on the uncaught throw.

## Why we chose what we chose

The readiness review settled the three open questions before work started (r1 on #256, Nick accepted each recommendation):

- **Q-1, the unbounded wait: (a) out of scope.** A timeout whose kill finds an empty group still waits for the escaped process to close the output. Ctrl-C or SIGTERM now restores the edit at once. Option (b), destroying the child's streams after a timeout so `close` comes early, is filed as #268.
- **Q-2, the evidence: (b)** an in-process test of `stopRunning()` on a real empty group, and one spawned-script test of the timer path. Option (c)'s second spawned test, of the signal path, was left out. The signal path calls the same `stopRunning()`, and its existing SIGINT/SIGTERM tests still pass.
- **Q-3, other kill errors: (a) treated like ESRCH.** The group holds only processes this runner started, as the same user, so any kill error means nothing is left that it may kill. Option (b) rethrew and logged them, but then macOS and Linux could differ on a zombie-only group, and a log line would have been the only difference.

The spec left nothing else open.

## What surprised us

- **Vitest passes the test when a timer callback throws.** Readiness assumption r1/A-4 asked us to check this first. With Vitest 5.0.2, a test that awaits while a `setTimeout` callback throws still reads `passed` in the JSON report. The run lists the throw under "Unhandled Errors" and exits 1. `npm run mutate` reads that as ERROR, which doesn't count as seen failing (#256's AC3). An in-process timer test couldn't have shown the bug, so the timer path is tested by spawning the script, as Q-2 (b) planned. In-process, the uncaught throw doesn't even end the run: the run settles when the grandchild exits, and the file is restored.
- **Re-indenting the kill refused no spike case.** The issue expected the `try` to re-indent the kill, so the two `stop-kill` cases (in `spikes/stryker/cases/113-self.json` and `168-followup.json`) would read REFUSED on a rerun. Their `find`, the kill with a two-space indent and a newline, is still a substring of the line with four spaces, so it still occurs once. Each of the ten cases #256 lists still occurs exactly once in the new `scripts/mutate.ts`. `stop-kill` would still apply: it deletes the kill and leaves two spaces of indent inside the `try`.

## Evidence

- The A-4 check, run outside the checkout: a one-file Vitest 5.0.2 project, Node 26.9.0, a test that awaits 200 ms while a 10 ms `setTimeout` callback throws. The JSON report reads `passed`, `numFailedTests: 0` and `success: true`; the console shows "Vitest caught 1 unhandled error"; the exit code is 1.
- Seen failing: the PR's `npm run mutate` table. Each edit undoes one thing `stopRunning()` now does (the bare kill, the removal inside the `try`, a `catch` narrowed to ESRCH) and names the new test that goes red.
- The spike case counts: each case `find` in the two files, counted in `origin/main`'s and the branch's `scripts/mutate.ts`. All 14 cases on `scripts/mutate.ts` whose id names a stop, a kill, a signal or `running` occur once in both.

## What's next

- #268: decide whether a timeout should settle without waiting for a process that left the command's group.
