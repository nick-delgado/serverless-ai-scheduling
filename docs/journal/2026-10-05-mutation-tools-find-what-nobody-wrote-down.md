# 2026-10-05 — Stryker finds breaks nobody listed, once patched for Vitest 5; an edit list re-checks only what it lists

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #113, PR #168, process log #72 (PR #132 review P1; batches 1, 2, 3 and 5), #140 (the coverage gate), PR #93, PR #97, PR #132, PR #153, PR #154, PR #155

## What happened

Every PR in the last review batches reported a hand-made "seen failing" pass, and every review still found a condition, value or wiring no test checked. Issue #113 asked whether a tool should replace or back up that pass. The trial agent measured three: **Stryker**, which invents its own mutants; an **exact-edit runner** (`mutate.ts`), which applies a list of `{ file, find, replace }` edits one at a time and prints `KILLED`/`SURVIVED` with the tests that failed; and the **#140 changed-line coverage gate**, with the per-file text report from the same run. Nick settled the method in the readiness review: run each tool at the reviewed commits where that is cheap, reason where it isn't and say so, and measure the runner with each PR's own recorded break list, translated into exact edits.

That meant eight historical commits in throwaway worktrees: `555dfc5` (#93), `8bea70b` and `5765869` (#97), `34a7831` (#132), `04f8fc4` (#154), `cf1c903` and `718f82f` (#153), and `5d54a70` (#155). We ran Stryker on the tools package and the simulator, the gate at all eight commits, and 293 translated breaks plus 39 of the reviews' own breaks through the runner (two of those 39, #153's TEST-2 breaks, sit in #153's list file so that its re-run covers them). The spike's README has the commands, versions and translation rules (`spikes/stryker/README.md`), and the outputs are in `spikes/stryker/results/`.

Stryker didn't work out of the box. With `@stryker-mutator/vitest-runner` 10.0.0 on our Vitest 5.0.2, `packages/tools/src/tools/*.ts` scored **6.74%**: 311 of 341 mutants "survived", because the runner's per-test name filter matches no test under Vitest 5 (stryker-js issue 6210, fix proposed in PR 6214). A two-line patch to `node_modules` (`spikes/stryker/patch-vitest5.sh`) fixed it: the same files then scored **93.55%**.

## Why we chose what we chose

The recommendation, per tool (AC 8; nothing becomes a required check):

| Tool | Recommendation | Because |
|---|---|---|
| `#140` gate | **keep as is** | It caught 3 of the 19 review findings below in full and 1 in part, for about 20–30 s of a run CI already makes, with almost no noise |
| per-file coverage report | **don't add** | Over the same run it showed one finding the gate didn't (an equivalent operand) and missed one the gate caught; it truncates file names and line lists |
| `mutate.ts` | **adopt on demand**: `scripts/mutate.ts`, `npm run mutate`, a `CLAUDE.md` line (this PR) | It finds nothing nobody wrote down, but it made one hidden miss visible (#132's `index.html` operand), refuses an edit that matches two places, and re-running a PR's list regenerated the seen-failing table, including the stale row #153's re-check found. No dependency, about 1–18 s per edit |
| Stryker | **neither, for now**; retry on demand for `packages/tools` and `packages/evals` once the Vitest 5 fix ships | It caught the most review findings (3 in full and 4 in part of the 10 in its files, and by its mutator list 3 and 1 of the 9 wave-4 cases) and found real gaps on `main`, but only with a patch to `node_modules`, and adoption would add three devDependencies to every install |

Where a PR keeps its edit list: in the PR description, as a collapsed JSON block, so a review round can copy it into `$TMPDIR` and re-run it; a list too long for the description goes in a committed file the description links. The trial's own lists live in `spikes/stryker/cases/`, including this PR's seen-failing list for `scripts/mutate.ts` (`cases/113-self.json`, 117 edits; output in `results/113-self.txt`). Whether the PR template's Seen-failing line becomes "the output of `npm run mutate`" is #72's B5-5.

Decisions the spec left open, each with the alternative it beat:

- **Patch Stryker rather than only report that it can't run.** AC 1 allowed "if it can't, say why". We did both: the unpatched number is above, and a patched run measured what the tool would catch once the fix ships. Without the patch, AC 2 and AC 3 would have measured a bug.
- **Which list version to translate.** The PR description as it stood at the reviewed commit, from GitHub's edit history of the PR body, not the final description (which already includes the review's fixes).
- **How to translate prose.** Each row becomes the narrowest exact edit its words allow ("removing the `index.html` check" → the `index.html` operand), with a `translation` note where the prose leaves room. The other reading is listed beside it where it changes the result.
- **#93 and #97's own lists.** Q-3 names #132, #153, #154 and #155. We translated #93's five breaks too (one tools file, as AC 5 asks). #97's 54 breaks are described by area ("each guard", "label and quote stripping"), so we ran only the breaks its reviews found.
- **#155's list at `5d54a70`.** Five groups of its first sweep name code the review round replaced; they're recorded as not applicable (`cases/155-not-applicable.json`), and the after-review group stands in for them.
- **The equivalence rule.** A mutant is equivalent when no input its callers can produce gives a different result, error or written value; a different message counts as different. All 22 on the tools files were checked; on the simulator (74), a random 30, picked by sorting on `sha1("113:" + id)`.
- **The TypeScript checker: off.** It removed 175 of 341 tools mutants as compile errors and tripled the run time (68.5 s → 192.7 s), and the survivors it removed include the three untested `if (!provider) throw` guards, the class of #93's TEST-2.
- **`mutate.ts` behaviour beyond the approved proposal.** Readiness review A-5 added `ERROR` (Vitest failed, no test failed), `TIMEOUT` (counted as detected, as Stryker does) and no test names off Vitest. We also made it: run the command once unedited first and stop if that fails; exit 2 for any refused or errored edit; handle SIGTERM as well as SIGINT; kill the command's whole process group on a timeout or a signal; write `--json` output; take `--only <ids>`; and, after the review of `982c244`, exit 2 for an edits file it can't read or that isn't a list of edits, for an `--only` id no edit has, and for a command it can't start, and refuse an edit whose file it can't read.
- **What's committed.** Text summaries of the Stryker reports and the runner's output, not the full JSON and HTML reports (several hundred KB each, with local paths).
- **Node 26.** The machine had only Node 26.9.0; `.nvmrc` asks for 24.
- **Follow-ups filed by Nick, not the trial agent.** After the review of `982c244`, Nick filed them: the tools test gaps are a Tests block on #77, the simulator survivors are noted on #108, and the Stryker retry is #169.

## What surprised us

**The runner caught what it was given, and the lists left out what the reviews found.** Agents already write exact edits: #154's PR listed 105, and #155's 88. Translated and run at their reviewed commits, the lists went 42 of 43 (#132), 105 of 105 (#154), 93 of 95 (#155), 42 of 45 (#153) and 5 of 5 (#93) killed. Each survivor has a cause: #132's one is a real gap (the review's TEST-1, below); #155's two (rows 94–95) are a translation artifact, constants replaced by literals of the same value, which no test can see; #153's three (`z7` to `z9`, the `clientMessageId` spread in `dynamo/items.ts`) are an environment skip, since only the DynamoDB Local test reaches them and it skips locally. #153's list file also holds the review's two TEST-2 breaks (`l2`, `q2`), which survived at `cf1c903`; they are the review's, not the PR's, and come up again below. Of the nine wave-4 cases the reviews found (below), seven weren't on their PR's list, one (#155's VER-1) was there as the other operand of the same `??`, and one (#153's TEST-1) was on it with a claim its output doesn't support. Written as edits, the seven missing ones survived (for #154's timeout constant, the longer value survived and the shorter was killed). They weren't hidden by a vague "removed the check"; they simply weren't tried. Only #132's first sweep had the problem P1 predicted: its "removing the `index.html` check", made exact, is the one `SURVIVED` row, and it is the review's TEST-1.

**A wrong edit can still be "KILLED".** #154 wrote its deletions as `` `(deleted)` ``, and our first translation took that literally. Of those 29 edits, 28 came back KILLED, because `(deleted)` is a `ReferenceError` in TypeScript, and 1 came back ERROR (it was a parse error inside JSX). The test names gave it away: 27 of the 28 differed from the corrected run's. A table generated from the output is only as good as the edits, and the names are what a reviewer can check.

**Re-running a list finds stale rows, and flaky tests.** We ran #153's list file (its 45 rows plus the review's two TEST-2 breaks, 47 edits) at `cf1c903` and again after the review's fixes at `718f82f`. 16 rows changed. In 12 of them the change came from the fixes: the two breaks the review added went from SURVIVED to KILLED, a renamed test changed three rows, and a new conflict test joined seven. Row y4 lost "sends the conversation a failed first turn's error names with Retry". That is exactly the stale claim #153's re-check reported as VER-1, so a regenerated table would have dropped it. Four rows changed only because one `ChatPage` scroll test ("turn details scrolls the end of the conversation into view…") failed in some runs and not in others, the timing problem #134 tracks. A row's own wording can also fail to match any edit: our translation of f2 ("the cap moved before `#classify`") doesn't turn the two tests the row names red at either commit.

**One review claim didn't hold up under a run.** #97's review of `8bea70b` said removing `key.includes("_") &&` turns no test red. At `8bea70b` it does, in both Stryker and the runner, but through "the window is 8 words: a 7-word overlap passes, 8 is a leak", whose fact key `f` happens to occur in the reply. The gap the review meant (a single-word key like `reason`) was real; the kill was an accident. Again the failing test's name is the evidence.

**Stryker's blind spots are its mutator list.** It has no mutator for a numeric literal, for deleting one statement, for a plain `=` assignment, or for dropping one character from a regex class. So it can't see #97's default of `2` (TEST-103), #154's `10_000` timeout constant or its lone `session.current = null`, or #97's curly-quote unwrapping. What it caught that nobody listed were operands, early returns, ternaries, regex anchors and quantifiers, and string and object literals.

## Evidence

All runs local, `CI` unset (DynamoDB Local tests skip), Apple M3, Node 26.9.0, Vitest 5.0.2, Stryker 10.0.0 with `concurrency: 4` and `coverageAnalysis: "perTest"`.

The commands behind the numbers below (the spike's README has the setup and each commit's test command):

```bash
# Stryker on main (dd754fa): results/main-tools-unpatched-runner.txt (before the patch), then results/main-*.txt
npx tsx spikes/stryker/run.ts --package packages/tools --files 'packages/tools/src/tools/*.ts' --checker off --label <label>
spikes/stryker/patch-vitest5.sh
npx tsx spikes/stryker/run.ts --package packages/tools --files 'packages/tools/src/tools/*.ts' --checker off|on --label <label>
npx tsx spikes/stryker/run.ts --package packages/evals --files '<the simulator files>' --label <label>
node spikes/stryker/summarize.mjs spikes/stryker/results/<label>.json > spikes/stryker/results/<label>.txt

# The gate and the per-file report at a reviewed commit: results/at-<sha>/gate.txt and coverage-text.txt
spikes/stryker/at-commit.sh <sha> <base>

# An edit list at that commit: results/at-<sha>/mutate-<list>.txt (row comparison: compare-rows.mjs)
npx tsx <trial>/scripts/mutate.ts <trial>/spikes/stryker/cases/<list>.json --json <out.json> -- <test command>

# This PR's own list and the review follow-ups: results/113-self.txt and results/168-followup.txt
npx tsx <copy>/mutate.ts spikes/stryker/cases/113-self.json -- npx vitest run --project scripts scripts/mutate.test.ts
npx tsx <copy>/mutate.ts spikes/stryker/cases/168-followup.json -- npx vitest run --project scripts scripts/mutate.test.ts scripts/coverage-changed.test.ts
```

The runner's copy has to sit in an ES-module directory (in this repository, or next to a `package.json` with `"type": "module"`): elsewhere tsx loads it as CommonJS, `import.meta.main` is unset, and it exits 0 having run nothing, which we found by running the copy from a scratch directory.

**Stryker on `main` (`dd754fa`), patched** (AC 2; `results/main-*.txt`):

| Files | Checker | Mutants | Killed | Survived | No coverage | Compile error | Score | Wall time |
|---|---|---|---|---|---|---|---|---|
| `packages/tools/src/tools/*.ts` (unpatched runner) | off | 341 | 23 | 311 | 7 | — | 6.74% | 58.7 s |
| `packages/tools/src/tools/*.ts` | off | 341 | 319 | 15 | 7 | — | 93.55% | 68.5 s |
| `packages/tools/src/tools/*.ts` | on | 341 | 152 | 9 | 5 | 175 | 91.57% | 192.7 s |
| `packages/evals/src/simulator/**` | off | 441 | 359 (+8 timeouts) | 70 | 4 | — | 83.22% | 388.5 s |

Equivalence check, by the rule above:

- **Tools:** 6 of 22 equivalent (27%). These are `slot.appointmentId !== undefined → true` and `!result.ok → true` in `book_appointment`, both halves of an unreachable guard in `get_my_appointments` (`:47`), `range.start_date < today → <=` and `{ specialty } → {}` in `check_availability`. The 16 gaps:
  - 8 mutants on one untested operand in two files: an established-patient history that is only `BOOKED` (`book_appointment.ts:75`, `reschedule_appointment.ts:138`);
  - 6 on three untested `if (!provider) throw` guards, whose removal still ends in INTERNAL through a TypeError;
  - 2 on hint texts no test pins.
- **Simulator sample:** 6 of 30 equivalent (20%). These are a loop bound that only adds windows too short to match, two `?? ""` on a capture group that always matches, a `kind === "tool_call"` operand implied by `name`, a `!== undefined` operand implied by `>=`, and an `issue?.path` on a list Zod never leaves empty. The 24 gaps: 16 on behaviour (for example, an assistant label anywhere on a line, "let me check availability" without "the", a reply wrapped in quotes with text after the closing one), 4 on texts, and 4 on edge inputs.

**The reviews' findings in Stryker's files, measured at the reviewed commits** (AC 3; ✓ caught, ~ partly, ✗ missed; "as an edit" is the review's break run through `mutate.ts`):

| Finding | Stryker | Gate | Per-file report | PR's list | As an edit |
|---|---|---|---|---|---|
| #93 `555dfc5`/TEST-1: status check above the same-slot answer | ~ the survivor `current.status !== "BOOKED" → false` needs the same missing test | ✗ | ✗ | left out | SURVIVED |
| #93 TEST-2: two untested throws | ✓ 5 mutants | ✓ `:90-93`, `:161` | ~ `:91` only | left out | SURVIVED ×2 |
| #97 `8bea70b`/TEST-1, TEST-2: `key.includes("_") &&` | ✗ killed by an unrelated test | ✗ | ✗ | not translated | KILLED by the same test |
| #97 TEST-1: replay's `kind` operand (equivalent; the fix removed it) | ✓ | ✗ | ✓ `48-52` | not translated | SURVIVED |
| #97 TEST-3: curly-quote unwrapping | ✗ no mutator | ✗ | ✗ | not translated | SURVIVED ×2 |
| #97 TEST-3: spaced and hyphenated stop reasons | ✓ | ✗ flags `:79`, `:85`, but for a `?? ""` arm | ✗ the same lines, for the same arm | not translated | SURVIVED ×2 |
| #97 `5765869`/TEST-101: four request fields | ~ the tag only | ~ the tag arm `:154` | ~ `:152` | not translated | SURVIVED ×5 |
| #97 TEST-102: `\|\| "(root)"` | ✓ | ✓ `:74` | ✓ | not translated | SURVIVED |
| #97 TEST-103: the default escalation allowance of 2 | ✗ no numeric mutator | ✗ | ✗ | not translated | SURVIVED |
| #97 TEST-104: replay keyed on the scenario | ✗ | ✗ | ✗ | not translated | KILLED: our trial-only key fails 2 tests; the review's edit wasn't exact |
| #97 TEST-105: the `(none)` branch | ✓ | ✗ the arm ran | ✗ | not translated | SURVIVED |

Stryker: 3 caught, 4 in part, 3 missed of 10 findings. Gate: 2, 1 and 7. #97's `runner.ts` and `cli.ts` findings (TEST-4 to TEST-6) are outside both globs.

**#132 at `34a7831`** (AC 5; `deploy-web.sh` is bash, so Stryker and the gate don't apply; the gate passed): the PR's 43 breaks went 42 KILLED and 1 SURVIVED (row 25, the `index.html` operand = TEST-1). The whole `if` (`132-25w`) is KILLED. TEST-2's four breaks and TEST-3's two weren't on the list; as edits, all six SURVIVED. Time: 390 s, about 9 s per edit. #93's five breaks at `555dfc5` were all KILLED (54 s).

**The wave-4 cases** (AC 6; Stryker reasoned from its mutator list, the rest measured):

| Case | Stryker (reasoned) | PR's list | As an edit | Gate |
|---|---|---|---|---|
| #154 `04f8fc4`/TEST-102: `clearInterval(ticker.current)` in `discard()`, a statement in two places | ✗ no statement deletion | left out (the list deleted `send()`'s copy, with context) | SURVIVED; written bare, REFUSED (2 copies) | ✗ |
| #154 TEST-105: `session.current = null`, a lone assignment | ✗ no `=` mutator | left out | SURVIVED | ✗ |
| #154 TEST-203: `tabIndex={-1}`, a JSX attribute | ~ `-1 → +1`, which also survives the fix (noise) | left out | SURVIVED | ✗ |
| #154 TEST-101: `FINAL_TIMEOUT_MS = 10_000`, a constant where it's defined | ✗ no numeric mutator | left out (the list changed the `setTimeout` argument) | `5_000` KILLED, `15_000` SURVIVED | ✗ |
| #154 TEST-104: `DEV_MOCK_OPTIONS`, a default where it's defined | ✓ `{}` would survive | left out | SURVIVED ×2 | ✗ |
| #155 `5d54a70`/VER-1: `deps.sources ?? SOURCE_GLOBS`, a default where it's used | ✗ its mutants crash and are killed | the list broke the other operand (KILLED) | SURVIVED; broken at the definition, KILLED by the glob tests | ✗ (passed) |
| #153 `cf1c903`/TEST-2: `if (!appended) return;`, a guard's early return | ✓ `!appended → false` | left out | SURVIVED (KILLED at `718f82f`) | ✓ `:333` |
| #153 TEST-2: `send.kind === "new" ? undefined : send.kind` | ✓ | left out | SURVIVED (KILLED at `718f82f`) | ✗ |
| #153 TEST-1: `writeLoginSession`, shared by two callers | ✗ stops at the first killing test | in the list (y4) | KILLED; the output names each failing test, so the row's claim can be read off it | ✗ |

Stryker: 3, 1 in part, 5 missed of 9. Gate: 1 of 9. The PR lists showed none of the 9 as SURVIVED.

**The runner's cost per edit** (one test-command run each, plus one unedited run): #154's voice tests 1.3 s (141 s for 105), #155's script test 6.2 s (594 s for 95), #132's deploy test 8.9 s, #153's four projects 15–18 s (719 s and 847 s for 47). The #140 gate: 18–31 s for the whole suite with coverage, plus 1–2 s for the check.

**This PR's own seen-failing pass** was run by the runner on `scripts/mutate.ts` (`cases/113-self.json`). The first pass, 87 breaks, left 10 survivors: the Vitest JSON reporter flag, the command's output, killing only the direct child on a time-out, the report directory never removed, the summary's counts, the refused-detail condition, and forgetting a finished command. Each got a test (one, the stale process group, after a small refactor into `stopRunning()`). The pass before the review, 91 breaks, was 90 KILLED and 1 TIMEOUT (`clearTimeout` deleted). The review of `982c244` found that the stop and signal tests couldn't tell a group kill from killing only the direct child, because the checker they ran was the whole group. They now run it under `sh`, as the time-out test does, and killing only `running.pid` in `stopRunning()` turns red the in-process stop test and both signal tests. That round also added checks and tests (an edits file that can't be read or isn't a list of edits, a command that can't be started, an `--only` id no edit has, the reporter flags, the 2,000-character error tail, and a survivor beside a refused edit). The list's edits were rewritten where the code changed and new ones added for the new code: 117 breaks, 116 KILLED and the same 1 TIMEOUT. While we ran it, the orchestrating session noticed about a dozen idle `checker.cjs` processes on the machine. They came from the passes themselves: a broken runner (one that kills only the direct child, say) left the test's hung checker behind, and so did a test process killed at its time-out. A clean run left none. The tests now kill any checker still running after each test and fail it, the checker ends on its own after 30 s (exit 1) so a broken kill path can't leave it behind for good, and the passes also showed a real gap: the runner left its report directory behind when a signal ended it, which it no longer does. We killed only those orphans (all under `$TMPDIR/mutate-test-*`) and removed the runner's leftover temporary directories.

**The gate couldn't read this branch.** `scripts/coverage-changed.ts` read `git diff` through `execFileSync`'s default 1 MB buffer. With the full Stryker reports committed, this branch's diff passed 1 MB and the gate crashed with `ENOBUFS` instead of checking anything. We first trimmed the results to get under it; Nick then approved fixing the gate in this PR. It now reads git's output with a 256 MB limit (`GIT_MAX_BUFFER`), and a test commits a 2 MB file to a throwaway repository and expects the gate to pass. Reverting the buffer, or setting it back to 1 MB, turns that test red (`spikes/stryker/results/168-followup.txt`). We kept the trimmed results as they are: the JSON copies we dropped repeated the committed text output.

## What's next

- #169: re-try Stryker on demand for `packages/tools` and `packages/evals` once `@stryker-mutator/vitest-runner` ships the Vitest 5 fix (stryker-js PR 6214), checker off.
- #77 (a Tests block): the tools survivors on `main`, namely a `BOOKED`-only history for the established-patient check (`book_appointment.ts:75`, `reschedule_appointment.ts:138`) and the three `if (!provider)` guards.
- #108 (noted there): the simulator survivors.
- #72's B5-5: whether the definition of done's break list and the PR template's Seen-failing line point at `npm run mutate`.
