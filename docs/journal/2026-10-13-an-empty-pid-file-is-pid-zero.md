# 2026-10-13 — An empty pid file reads as pid 0, and `kill(0)` is the test run's own process group

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** issue #215, issue #206 / PR #214, issue #134 / PR #205, #184, the [2026-10-07](2026-10-07-the-closed-socket-was-a-passthrough.md) and [2026-10-05](2026-10-05-mutation-tools-find-what-nobody-wrote-down.md) entries

## What happened

PR #214's load rounds lost whole test suites to `Killed: 9`, and the 2026-10-07 entry suspected `npm run mutate`'s process-group kill reaching the wrong group. Issue #215 asked us to find out, and to stop any path a test can force. Nick settled the readiness questions before work started: fix whatever a deterministic test can show, whether or not load reproduces it (r1/Q-1 (a)); measure with six parallel loops of `scripts/mutate.test.ts` beside a full suite (r1/Q-2 (a)); and have the tests' after-each hook send no signal at all (r1/Q-3 (c)).

The agent read the kill sites first. Two can send SIGKILL: `stopRunning()` in `scripts/mutate.ts`, which kills the group of the command it started, and the tests' after-each hook, which killed whatever pid `checker.pid` held. The checker writes that file with `writeFileSync`, which creates and truncates it and then writes. A checker killed between those two steps (the tests time it out after 1 s, about as long as a Node start takes under load) leaves the file empty. `Number("")` is 0. `alive(0)` was true, because `kill(pid, 0)` with pid 0 checks the caller's own process group. So the hook sent `process.kill(0, "SIGKILL")`, which kills the Vitest process and every forked worker in its group: the whole suite, or, without a session of its own, everything else in that group too. That fits both shapes PR #214 saw. Before its worker used `setsid`, a whole round died at once. After that, single suites died.

## Why we chose what we chose

- **The hook sends no signal (r1/Q-3 (c)).** A checker left running still fails the test, and it ends on its own within 30 s. `alive()` reads anything but a positive integer as not running. That covers 0, the caller's group; a negative pid, a group (and -1, every process the user owns); and `NaN`, which Node rejects. The hook's check is now a helper, `checkerLeftRunning`, so a test can write each bad pid file and assert, through a stubbed `process.kill`, that no signal is sent.
- **`stopRunning()` is unchanged.** The other suspected path was pid reuse: the command's group exits and its id goes to a new group before `close` is handled. The agent checked that macOS doesn't do that. It forked until the pid counter wrapped. While one member of a group lived, the counter skipped the group's id. Once the member exited, the same id was handed out again. Reaching a foreign group from `stopRunning()` would take every member gone and about 100,000 forks before Node handles `close`. No test can force that, so under r1/Q-1 (a) it would be fixed only if the load log showed it. The log didn't. Keeping `stopRunning()` as it is also keeps the whole-group kill from the 2026-10-05 entry, and the spike cases that quote it.

## What surprised us

- **The load run didn't reproduce it, either way.** The temporary logging recorded every kill site's target, the target's group and its command lines. On Node 26.9.0 (the machine has no Node 24), every `stopRunning()` kill reached the checker's own group, and the before run on `2e73ded` never wrote an empty `checker.pid`. The PR's Verification table has the counts. The empty-file path needs a SIGKILL to land between two system calls, which is rare, so a quieter run than PR #214's six full suites may simply not hit it.
- **No memory-pressure kill either.** A kernel kill of a suite would be a jetsam event. The unified log still covers 2026-10-07, when PR #214's rounds ran, and has no kernel `memorystatus`, `jetsam`, kill or compressor messages since 2026-10-06. So the suites PR #214 lost weren't killed for memory. The pid-0 kill is the one path we found that sends a SIGKILL and fits what PR #214 saw. We haven't shown that it's the one that fired.
- **A spy that calls through is not a safe witness.** A test that spies on `process.kill` and passes the call on would really send SIGKILL to pid 0. The new tests stub it, so the old behaviour can be put back by a mutation without killing the run that checks it.

## Evidence

- The fix: `366ab61` (`scripts/mutate.test.ts` only). The guard's mutation table is in the PR's body (the PR on the Related line).
- r1/A-2: in a fresh session, a forked child's `process.kill(Number(""), "SIGKILL")` ended its parent with status 137.
- r1/A-4: the pid-reuse check is a small C program in the agent's scratch directory. With a group member alive, the counter passed the group's id without handing it out. After the member exited, the id came back on the next pass.
- The load runs: six loops of `vitest run scripts/mutate.test.ts`, each run in its own session (perl `POSIX::setsid`, since macOS has no `setsid`), beside one full `vitest run` at a time. The counts are in the PR's Verification table. Other agents' test suites ran on the machine at the same time.

## What's next

- If load rounds like #206's run again, count `Killed: 9` suites with this fix in. A suite still killed with no logged kill and no jetsam event would point somewhere else.
