# Spike #113: Stryker, an exact-edit runner and the coverage gate

Throwaway measurement code for issue #113. It compares three ways of finding a condition, value or piece of wiring that no test checks:

- **Stryker** (`@stryker-mutator/core` with the Vitest runner), which writes its own mutants;
- **the exact-edit runner**, which applies a list of `{ file, find, replace }` edits one at a time (built here as `spikes/stryker/mutate.ts`, now `scripts/mutate.ts`, `npm run mutate`);
- **the #140 changed-line coverage gate** (`npm run test:coverage && npm run coverage:changed`), plus the per-file text report from the same run.

The findings and the recommendation are in [the journal entry](../../docs/journal/2026-10-05-mutation-tools-find-what-nobody-wrote-down.md). This README says how the numbers were made, so they can be made again.

## Versions and machine

| | |
|---|---|
| Stryker | `@stryker-mutator/core`, `@stryker-mutator/vitest-runner`, `@stryker-mutator/typescript-checker`, all `10.0.0`, installed with `npm i --no-save` (no `package.json` here, so the lockfile doesn't change) |
| Vitest | 5.0.2 (the repo's), `@vitest/coverage-v8` 5.0.2 |
| Node | 26.9.0 (the only one on the machine; `.nvmrc` asks for 24) |
| Machine | Apple M3, 8 cores, macOS 26 |
| Stryker settings | `concurrency: 4`, `coverageAnalysis: "perTest"`, `timeoutMS: 10000`, checker off unless a run says on |
| Environment | local, `CI` unset, so the DynamoDB Local tests skip (they cover `packages/tools/src/repos/dynamo`, not `src/tools`) |
| `main` measured | `dd754fa` |

## Files

| File | What it is |
|---|---|
| `stryker.config.mjs` | Stryker config, driven by `STRYKER_PACKAGE`, `STRYKER_CHECKER`, `STRYKER_LABEL`, `STRYKER_CONCURRENCY` and `STRYKER_RESULTS` (`run.ts` sets the first four) |
| `vitest.package.config.ts` | Points Vitest at one package (`STRYKER_PACKAGE`), so Stryker runs that package's tests, not the root `test.projects` set |
| `run.ts` | Runs Stryker on one package's changed source files (`git diff --name-only <base>...HEAD -- <package>/src`), or on `--files` |
| `patch-vitest5.sh` | The local patch the Vitest runner needs under Vitest 5 (below) |
| `at-commit.sh` | Checks out a reviewed commit in a throwaway worktree, runs the suite with coverage and the #140 gate there |
| `summarize.mjs` | Turns a Stryker JSON report into the summaries in `results/` |
| `compare-rows.mjs` | Compares two runs of one edit list, row by row (AC 7) |
| `cases/<pr>.json` | Each PR's own recorded break list as exact edits (readiness review Q-3 (a)). It can also hold breaks a review added, tagged in their `translation` field (`153.json`'s `l2` and `q2`), so a re-run at the fixed commit covers both |
| `cases/<pr>-review.json` | The breaks the PR's review found, as exact edits |
| `cases/155-not-applicable.json` | #155 list items that no longer name code at the reviewed commit |
| `cases/113-self.json` | This PR's own seen-failing list for `scripts/mutate.ts` (output: `results/113-self.txt`) |
| `results/` | Outputs (Prettier-ignored). `main-*` on `dd754fa`; `at-<sha>/` at a reviewed commit |

## Stryker needs a patch under Vitest 5

`@stryker-mutator/vitest-runner` 10.0.0 builds each test's name with a space between the suite and test names, then runs a mutant's covering tests with `testNamePattern` set to those names. Vitest 5 matches `testNamePattern` against the names joined with `" > "`, so nothing matches, no test runs, and every covered mutant "survives". Unpatched, `packages/tools/src/tools/*.ts` scored **6.74%** (23 killed, 311 survived of 341; `results/main-tools-unpatched-runner.txt`); `coverageAnalysis: "off"` didn't help (get_patient_profile.ts: 1 of 11 killed). This is stryker-js issue 6210, with a fix proposed in PR 6214. `patch-vitest5.sh` makes the same change in `node_modules` (two `join(' ')` → `filter(Boolean).join(' > ')`). Patched, the same files score 93.55%. A second Vitest 5 problem: `--logLevel debug` crashes the runner (`Converting circular structure to JSON`).

## Commands

```bash
# Once per checkout (node_modules only; `npm ci` undoes it)
npm i --no-save @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0 @stryker-mutator/typescript-checker@10.0.0
spikes/stryker/patch-vitest5.sh

# AC 1: Stryker on one package's changed files (vs origin/main), or an explicit list
npx tsx spikes/stryker/run.ts --package packages/tools [--base origin/main] [--dry]
npx tsx spikes/stryker/run.ts --package packages/tools --files 'packages/tools/src/tools/*.ts' --checker on|off --label <name>
node spikes/stryker/summarize.mjs spikes/stryker/results/<name>.json > spikes/stryker/results/<name>.txt

# The coverage gate at a reviewed commit: <base> is the merge base with main as it was when the PR merged
spikes/stryker/at-commit.sh <sha> <base>

# An edit list at that commit (from the throwaway worktree)
npx tsx <trial>/scripts/mutate.ts <trial>/spikes/stryker/cases/<list>.json --json <out.json> -- <test command>
git worktree remove --force .worktrees/113-at-<sha7>
```

The historical edit lists ran with the runner as committed in `8cf1743` (`spikes/stryker/mutate.ts`), which `scripts/mutate.ts` replaced; the output format is the same. The gate ran from this branch's `scripts/coverage-changed.ts` against each old worktree, with #140's coverage options passed on the command line (the old `vitest.config.ts` files have none) and `@vitest/coverage-v8` 5.0.2 installed with `--no-save` where the commit predates #140.

| Reviewed commit | PR | Gate base | Test command for the edit lists |
|---|---|---|---|
| `555dfc5` | #93 | `743c04b` | `npx vitest run --project @sched/tools` |
| `8bea70b`, `5765869` | #97 | `c7ac5d5` | `npx vitest run --project @sched/evals` |
| `34a7831` | #132 | `41b43da` | `npx vitest run --project scripts scripts/deploy-web.test.ts` |
| `04f8fc4` | #154 | `633a4ce` | `npx vitest run --project @sched/web apps/web/src/voice apps/web/src/chat/ChatPage.voice.test.tsx apps/web/src/styles/global.test.ts` (the PR's own) |
| `cf1c903` | #153 | `633a4ce` | `npx vitest run --project @sched/api --project @sched/web --project @sched/contracts --project @sched/tools` |
| `718f82f` | #153 | `4527fdb` | the same |
| `5d54a70` | #155 | `4527fdb` | `npx vitest run --project scripts scripts/coverage-changed.test.ts` (the PR's own) |

## Translating a PR's break list

Each list in `cases/` comes from the PR description as it stood at the reviewed commit (GitHub's edit history of the PR body). A row the prose leaves open is translated to the narrowest edit it can mean, and the entry's `translation` field says so. The translation choices that changed a result:

- #132 row 25, "removing the `index.html` check": the narrowest edit (the `index.html` operand of a two-operand `if`) is `132-25`; the whole `if` is `132-25w` in the review list.
- #153 row f2, "the cap moved before `#classify`": our edit doesn't turn the two tests the row names red at either commit, so the PR's edit was a different one.
- #154: the PR's list was already written as exact edits; its `⏎ ` stands for a newline and the next line's indentation, which the translation recovers from the file. Its `` `(deleted)` `` was first taken literally (see the journal: 28 of 29 such edits were still reported KILLED).
- #155: 5 groups of the first sweep name code that the review round replaced (`cases/155-not-applicable.json`); the after-review group stands in for them. Rows 94–95 replace the coverage block's constants with literals of the same value, which no test can see; the PR's own edit is unknown.
- #93 and #97 aren't in Q-3's list. #93's five breaks are translated (`cases/93.json`); #97's 54 breaks are described by area, not edit, so only the review's breaks are run (`cases/97-review-*.json`).

## Equivalent-mutant check

Rule: a surviving or uncovered mutant is **equivalent** when no input its callers can produce gives a different result, error or written value (a different message text counts as different). Otherwise it is a **gap**; gaps are split into a missing check of behaviour, a text no test pins, and an edge case. On `packages/tools/src/tools/*.ts` every one of the 22 survivors and uncovered mutants was checked; on `packages/evals/src/simulator/**` (74) a random 30, chosen by sorting mutant ids on `sha1("113:" + id)`. The classifications are in the journal entry.
