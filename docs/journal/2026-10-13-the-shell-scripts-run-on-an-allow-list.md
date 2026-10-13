# 2026-10-13 — The deploy scripts' tests run on an allow-listed PATH, so a missing stand-in can't reach AWS

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #137, PR #258, #257, PR #131, PR #132, #100, #35, #157

## What happened

`scripts/deploy.sh`'s SES block (#35) reads `SES_SENDER` and `SES_STAFF_RECIPIENT` from the environment, this checkout's `.env` or the main checkout's `.env`, and passes them to the api stack as `NoEcho` parameters. PR #131 checked it by hand in seven cases ([the staff-email entry](2026-10-04-the-staff-email-must-not-carry-its-own-address.md) points here), and `scripts/teardown.sh` had no tests at all. An agent (Claude, as #137's task worker) gave both scripts tests that run them for real, the way `scripts/deploy-web.test.ts` (#100, PR #132) already ran its script.

The three test files now share one harness, `scripts/test/shell-harness.ts`. Each test gets a temporary directory with a throwaway git repo holding fresh copies of the script and, for `deploy.sh`, the four `infra/stacks` templates, with one commit. The test writes that repo's `.env`, so the developer's real `.env` is never read (r1/Q-1 (a)). The fallback cases add a `git worktree` of that repo, and one test checks that the copy's `repo_root` and the main checkout it falls back to are both inside the test's directory. Stand-in `aws`, `sam` and `npm` log every call. The stand-in `sam` writes only to that log, so a value it receives can't show up in the script's output by way of the stand-in.

`deploy.test.ts` covers AC1's SES cases, the argument checks, and r1/Q-2's guards: the credentials check, the ephemeral `DeletionProtection=disabled` default and a caller's own value winning, and overrides reaching only the templates that declare them. Every SES test also checks that neither value appears in the script's stdout or stderr, and that both reach the api stack's `--parameter-overrides`. `teardown.test.ts` covers the argument checks, "nothing to delete", the typed confirmation (no stdin, a wrong answer, the right one, `--yes`), the web → api → auth → data order, the site-bucket guard, and a failed wait. SAM's own `NoEcho` masking is still PR #131's hand check. No test here can see it.

## Why we chose what we chose

- **The guard is a narrow PATH, not an inherited one (AC3, r1/A-6).** `deploy-web.test.ts` used to prepend its stand-ins to the parent's `PATH`. With a stand-in missing, the run would have found the real `aws` next. Now a run's `PATH` is only the stand-ins' directory and a directory of links to an allow-list of tools (`bash`, `git`, `sed`, `awk` and the rest the scripts call), resolved from the parent's `PATH` when the sandbox is made. `aws`, `sam` and `npm` are never on that list. The harness spawns that linked `bash` by its absolute path. We checked first that Node's `spawnSync` resolves a command through the `PATH` in the `env` it's given (on macOS, Node 26): a probe ran from that `PATH` and wasn't found without it. The run also throws when a stand-in file is missing or the output says `command not found`. That matters because `deploy.sh` and `teardown.sh` send the `sts` call's stderr to `/dev/null`, so a missing `aws` would otherwise just look like expired credentials. `scripts/test/shell-harness.test.ts` removes each stand-in in turn, with an impostor of that name first on the parent's `PATH`. The run throws and the impostor never runs, and with the stand-in present the same run passes. The alternative was to keep the inherited `PATH` and check before the run that every stand-in exists. We rejected it because a script that called a fourth AWS-facing tool, or a stand-in deleted mid-run, would still reach the real thing.
- **The environment is built from scratch (r1/A-2).** Only `PATH`, `HOME` (the test's directory), the stand-ins' variables and a test's own values reach a run. A test exports SES values in the runner's own environment and checks that they don't reach the script.
- **One harness for all three files (r1/Q-4 (a)).** `deploy-web.test.ts` keeps its `FAKE_NPM` and its tests. It reports the same 31 test names before (`753391e`) and after (`9a2cc46`), and every one passes. `gitRepo` (`scripts/test/git-repo.ts`) gained an optional directory, so the repo sits inside the sandbox next to its stand-ins.
- **The agent's choices, where the spec left them open:**
  - The `.sh` breaks were written by hand (r1/A-8), as one edit per guarded condition, plus one for each place a value could be printed: the "Deploying" line, the refusal and the ephemeral note.
  - `teardown.sh`'s bucket guard is also tested with `other-sched-pr7-web-x`, so a leading `*` in its pattern would be caught. The issue named only `sched-other-web-x` and `sched-pr7-webx`.

## What surprised us

- **Deleting `deploy.sh`'s missing-target check changes nothing.** An empty target also fails the stack check, which prints the same usage line and exits 2. So the break we recorded makes that check exit 0 instead. Deleting it would have survived, and rightly so.
- **The review's guess about `export` and spaces was wrong in the safe direction.** It expected `export SES_SENDER=…` and `SES_SENDER = …` to reach SAM with the extra characters. A run shows `sed`'s `^SES_SENDER=` doesn't match those lines at all, so the value reads as missing: `dev` refuses, and an ephemeral env deploys without the email.
- **Our first mutate run marked every break KILLED-OTHER.** Vitest's reporter names a test `<file> > <describe> <describe> <test>`, with spaces between the describe blocks rather than ` > `, so none of the `expect` strings matched. The failed tests were the right ones; only the names were wrong.

## Quirks, filed as #257 (r1/Q-3 (a))

None is fixed or pinned here. Each was seen by running the script through the harness:

- unmatched quotes are stripped one end at a time (`"a@example.com'` → `a@example.com`);
- a CRLF `.env` passes a trailing `\r`, and an inline `# comment` is passed as part of the value;
- `export ` and spaces around `=` make a value read as missing;
- `deploy.sh`'s third argument becomes an override without `--`;
- a multi-word target (`"data auth"`) passes the stack check, calls `aws`, then fails with exit 2 in `awk`;
- `teardown.sh`'s second argument, if not `--yes`, is ignored and the prompt runs;
- `teardown.sh` with no stdin exits 1 with no "aborted" line;
- `teardown.sh`'s bucket read discards the CLI's error, so a throttled read skips emptying and the web delete fails later;
- `deploy.sh`'s missing-target check is redundant (above).

#257 also asks whether `scripts/retry-escalations.ts`'s `parseEnv` should agree with `dotenv_value`.

## Evidence

- Tests per file at `9a2cc46`: `deploy.test.ts` 40, `teardown.test.ts` 25, `test/shell-harness.test.ts` 4, `deploy-web.test.ts` 31 (31 at `753391e`, same names).
- Seen failing: the PR's `npm run mutate -- … --markdown` tables break each guarded condition in `deploy.sh` and `teardown.sh` (each env regex's anchors and both length bounds moved both ways, `dev` and `demo` dropped from each `PROTECTED_ENVS`, and r1/Q-2's list) and the harness's guard (the inherited `PATH`, stand-ins on the allow-list, the missing-stand-in and `command not found` checks, and the inherited environment).
- Bash: run locally on macOS's bash 3.2.57. CI's `ubuntu-latest` runs bash 5 in the `Lint, typecheck, test` job on this PR.
