# 2026-10-04 — CI now fails a line no test ran, including the right operand of `??`

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #140, PR #155, issue #72 (batch 3, proposal P1), PR #131 review, issue #113

## What happened

Batch 3 of the agent-process review (#72) found the seen-failing pass incomplete in 8 of the 9 PRs it read, and about half of the misses were code that no test ever ran: CLI entry blocks, default client factories, the right operand of a `??`, an error-text fallback. Agents drew up a list of breaks and checked that list, but nothing checked the list itself. Nick approved a mechanical gate for that class of miss (#140).

The agent built it. `npm run test:coverage` runs the whole Vitest suite with v8 coverage over `packages/*/src`, `services/*/src`, `apps/*/src` and `scripts/*.ts`, tests excluded. `scripts/coverage-changed.ts` then takes the lines added by `git diff -U0 -M <base>...HEAD` and prints each one, as `file:line`, that sits in a statement that never ran or starts a branch arm that never ran (an `if`/`else` arm, a ternary arm, the right operand of `??`, `||` or `&&`). It exits 1 if there are any. CI runs both steps in the existing `Lint, typecheck, test` job instead of `npm test`. PR runs diff against the PR's base SHA, and push runs diff against `origin/main`.

A line can opt out with an ignore hint in the diff, `/* v8 ignore next -- <reason> */`. Nick decided (r1/Q-1) that the gate also fails a hint with no reason after `--`, so every exception says why in the code. The gate's own CLI entry block is the first such hint.

We planted two untested branches in `packages/tools/src/clock.ts` on a throwaway branch: an `if (ms < 0) return 0;` and a `date.trim() || String(NaN)` whose right operand no test reaches. The whole suite stayed green, 1,859 of 1,859. The gate printed both lines and CI went red on that step.

## Why we chose what we chose

- **Read Vitest's istanbul-shaped JSON, not raw v8 ranges.** Vitest 5 maps v8 coverage onto the AST, so `coverage-final.json` has typed branches (`if`, `cond-expr`, `binary-expr`, `default-arg`, `switch`) with one location per arm. "Flag the line where an unrun arm starts" works on that directly. An `if` with no `else` has an arm with no location, so an `if` body that ran is never flagged because its implicit `else` didn't.
- **The plain hint form, without `@preserve`.** The issue allowed for the transform stripping comments. A scratch project showed that Vitest 5 honours `/* v8 ignore next -- reason */`, the bare `/* v8 ignore next */` and the `//` form alike, so the docs use the plainest one. A bare `@preserve` doesn't count as a reason.
- **The diff and git config are pinned by flags, not assumed.** The script passes `-U0 -M --no-color --no-ext-diff` and `core.quotePath=false`. The tests set `color.diff=always`, `diff.external=false` and `diff.renames=false` in their throwaway repos. Without that, deleting `-M` from the script left every test green, because git detects renames by default.
- **Exit 2 when the gate can't run.** There are two cases: no coverage JSON, or no merge base in CI. Locally, a missing merge base warns and passes, as `scripts/adr-history.test.ts` already does.
- **Windows path handling was dropped.** `isAbsolute(rel)` and the separator rewrite could never fail on Linux or macOS, so no test could break them.

## What surprised us

- **Deleting a flag tells you more than a line count.** Eighty-eight single breaks of the script (operands, regex alternatives, each git flag, each default, each exit code) each turned a test red. Only after the test repos changed their git config, though. Five breaks survived the first sweep: the `stop` keyword, the hint's offset in the line, `continue` turned into `break`, the `--` check on a flag's value, and `-M`. Each got a test.
- **Coverage made the sign-in tests miss Testing Library's 1-second wait in CI.** Both CI runs of PR #155's head failed in the same three `LoginPage.test.tsx` tests: `findByRole("heading", { name: "Chat" })` gave up after 1 s. That file took 6.3 to 7.6 s on `main` without coverage, and 10.4 to 20.1 s with it, because the Cognito mock's SRP sign-in runs about 3x slower under v8 coverage. The run at 19.6 s passed and the one at 20.1 s failed. Locally, under coverage, a sign-in took about 460 ms. The agent raised `asyncUtilTimeout` to 3 s in `apps/web/src/test/setup.ts`, one line outside #140's paths, called out in the PR. Setting it to 1 ms turned 13 of the file's 28 tests red, so the setting does take effect. A longer budget only delays a wait that was going to fail, and no web test relies on a `findBy` timing out.
- **Coverage also makes one timing test flaky locally.** In 1 of 4 local full runs with coverage, `ChatPage.test.tsx` "scrolls the end of the conversation into view…" ran out of its 500 `setImmediate` hops (the `until` helper). It passed alone and in the other 3 runs, and CI has passed so far. We haven't touched it, because it is outside #140's paths. If it shows up in CI, the fix belongs in `apps/web/src/chat/testUtils.ts`.

## Evidence

- Local, Apple silicon, DynamoDB Local running: `npm test` 31.8 s, `npm run test:coverage` 34–42 s across 4 runs. On the branch, overall coverage is 95.6 % of statements and 91.1 % of branches (a figure, not a threshold).
- CI job `Lint, typecheck, test` before (the last three `main` runs): 2 min 42 s, 1 min 56 s and 2 min 26 s, with `npm test` taking 66–96 s. After, five green runs on PR #155's branch: 1 min 52 s to 3 min 04 s, with `test:coverage` taking 64–121 s and the gate under 1 s. The job averages about 15 s more (141 s to 155 s), well inside its 10-minute timeout.
- Planted defect: run [37243233424](https://github.com/nick-delgado/serverless-ai-scheduling/actions/runs/37243233424), where `coverage:changed` failed and printed `packages/tools/src/clock.ts:36` and `:130`.
- `scripts/coverage-changed.test.ts`: 48 tests. They call `main` in-process, because a child process records no coverage, against throwaway git repositories and hand-built coverage JSON.

## What's next

- Every open PR, once rebased on `main`, has to cover the lines it adds.
- The follow-up batch on #72 trims the seen-failing enumerations in `CLAUDE.md` now that the gate covers "never ran".
- #113's mutation trial compares its results with this gate. Coverage shows that a line ran, not that a test checks it.
