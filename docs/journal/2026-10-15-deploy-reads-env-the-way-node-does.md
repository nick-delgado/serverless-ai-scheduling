# 2026-10-15 — deploy.sh reads .env the way Node does, and both scripts refuse what they used to guess at

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #257, #137, PR #258, PR #132, PR #131, #72, #35

## What happened

#137's shell harness ran `scripts/deploy.sh` and `scripts/teardown.sh` for real and found ten quirks in how they read `.env` and their arguments ([the allow-list entry](2026-10-13-the-shell-scripts-run-on-an-allow-list.md)). Nick decided to fix all ten. His main call was the parser: `deploy.sh` no longer has its own `sed`-and-strip reader. It asks Node's `util.parseEnv`, the parser `scripts/retry-escalations.ts` already uses, so the two scripts read a `.env` file the same way by construction. A readiness review added two answers: a value that spans lines is refused (r1/Q-1 (a)), and if Node 24's parser misread one of the forms, `deploy.sh` would rewrite that form in the same `node` call (r1/Q-2 (a)).

An agent (Claude, as #257's task worker) built it:

- `deploy.sh` reads each SES key with an inline `node -e` call per `.env` file. The order is unchanged: a non-empty environment variable, then the worktree's `.env`, then the main checkout's. CRLF, an inline `# comment`, an `export ` prefix and spaces around `=` now read as the bare value. An unmatched quote on one line reaches SAM as written. A value with a line break or a carriage return stops the api deploy with exit 1, naming the key and never the value.
- `deploy.sh` refuses anything after the env that doesn't start with `--` (quirk 5), and a target that isn't exactly a stack name or `all` (quirk 6). Both checks run before any AWS call. The redundant empty-target check is gone (quirk 10). One message changes as a result: `deploy.sh "" Dev` now prints `invalid env: Dev (lowercase, 2-16 chars)` instead of the usage line. It still exits 2 with no AWS call.
- `teardown.sh` refuses a second argument other than `--yes`, and a third, with exit 2 (quirk 7). A closed stdin prints `aborted: no confirmation given (stdin closed)` (quirk 8). The site-bucket read treats only `ParameterNotFound` as "no bucket". Any other error prints the CLI's message and stops before any delete (quirk 9).
- The harness links `node` instead of `sed` and `tail`. Its stand-in `aws` can now fail a single SSM name (`FAKE_SSM_ERROR_NAME`), so the role-ARN read before the bucket read still succeeds.

## Why we chose what we chose

The quirk decisions and r1's answers are Nick's (#257, "Decisions and clarifications"). These are the agent's, where the spec left the choice open:

- **The bucket read joins stderr to stdout (`2>&1`) rather than writing it to a temporary file.** A failed `get-parameter` prints nothing on stdout, so the captured text is the CLI's error alone. A temporary file would have needed `mktemp` on the harness's allow-list and a cleanup trap. macOS's bash 3.2, which the harness runs locally, has no way to capture both streams separately without one. The cost: a warning printed on a successful read would join the bucket name. That fails the `sched-<env>-web-*` check, which stops before any delete, so it fails closed.
- **A `.env` that Node can't read stops the deploy (`|| exit 1`).** Without it, the `node` failure inside `$(…)` was swallowed (errexit doesn't reach a command substitution in bash), and the deploy quietly fell through to the main checkout's file. The alternative was to let it fall through, as a missing file does. We rejected that because an unreadable file is a mistake to see, not an absent one. Node's error names the path and `EACCES`, never a value.
- **The SES keys are read only when the api stack is in the target.** `deploy.sh data dev` no longer starts `node` at all. Q-1's edge already required that a broken `.env` not stop a deploy without the api stack, and reading only then makes that hold by construction.
- **A value whose only line break is a trailing one isn't refused.** In `SES_SENDER="a@example.com` followed by a lone `"` on the next line, `parseEnv` gives `a@example.com\n`, and bash's `$(…)` strips the trailing newline, so SAM gets the bare address. Keeping that newline (a sentinel character, stripped after) would have refused a value that reaches SAM clean. We left it out.
- **The reader function is renamed `env_file_value`**, so "`dotenv_value` is removed" holds literally and nobody reads the old name as the old parser.
- **`teardown.sh`'s refusal adds one line of its own**, `could not read /sched/<env>/web/bucket-name; stopping before any delete.`, after the CLI's unchanged error, so the reader knows the teardown stopped on purpose.

## What surprised us

- **Node 24 reads every form exactly as Node 26 does, so no rewrite was needed (r1/Q-2).** The agent ran the same probe of fifteen layouts on Node 26.9.0 (Nick's machine) and Node 24.22.0 (`npx node@24`, the `.nvmrc` major). Both give the same output, including the swallowed line in `SES_SENDER="a@example.com'` followed by `SES_STAFF_RECIPIENT="b@example.com"`: the sender becomes `a@example.com'` plus a line break plus `SES_STAFF_RECIPIENT=`, and the recipient key disappears. That's the layout r1/Q-1 refuses. The four test files also pass with Node 24 first on `PATH`, which is the `node` the harness links into the sandbox.
- **The parent's `node` runs in the sandbox (r1/A-4, verified first).** Here it's Homebrew's, a symlink to the real binary rather than a version-manager shim, so linking it from the parent's `PATH` works with `HOME` set to the test's directory. `process.execPath` wasn't needed. CI installs a real binary from `.nvmrc`.
- **A `node` failure inside `$(…)` doesn't stop a `set -e` script.** Bash runs command substitutions without errexit, so a reader without `|| exit 1` skips an unreadable `.env` silently. A probe showed it before the reader was written; the test that chmods `.env` to `000` now pins it, and the mutation that turns `|| exit 1` into `|| true` is how we saw that test fail.

## Evidence

- `npx vitest run --project scripts scripts/deploy.test.ts scripts/teardown.test.ts scripts/deploy-web.test.ts scripts/test/shell-harness.test.ts` passes on Node 26.9.0 and on Node 24.22.0.
- Seen failing: the PR's `npm run mutate -- … --markdown` table breaks each new check in `deploy.sh`, `teardown.sh` and the harness. The `.sh` rows are written by hand, because `--suggest` reads only `.ts` files.
- Bash: macOS's bash 3.2.57 locally. CI's `ubuntu-latest` runs bash 5.

## What's next

- `scripts/retry-escalations.ts` still differs in which value it picks (it keeps an environment variable set to `""` and reads only the repo root's `.env`). Nick decided it doesn't change (#257, "The parsers agree"), so nothing is filed.
