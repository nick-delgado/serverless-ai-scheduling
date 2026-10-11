# 2026-10-11 — A mutation suggester reads the code, and its first target was itself

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #240, PR #241, #72, PR #238, PR #237, PR #235, PR #231, PR #229, PR #228, PR #224, PR #217, #233, #169, #157, #215

## What happened

Process batch 9 (`improve-agent-process` over the reviews of PRs #220 to #238) found one cause far ahead of the rest: `test-cannot-fail`, 22 findings in 5 of 9 PRs. The agents had run `npm run mutate`, but they chose their breaks from the spec's rules, not from the code they wrote, so the code nobody listed went unbroken. #238's review found two such misses: the `c.ok` operand of `.filter((c) => c.name === "escalate_to_human" && c.ok)`, and the lookarounds of the italics regex. We had already reworded the mutation rule twice. This time Nick approved a tool instead of more words.

An agent (Claude, as #240's task worker) built `npm run --silent mutate -- --suggest > edits.json`. It reads the lines the branch adds with the TypeScript compiler API and prints an edits file: each operand of a `&&`/`||`/`??` chain dropped, each comparison moved to its boundary, each `===`/`!==` flipped, each number plus and minus one, and each regex lookaround and alternative removed. Each `find` widens by whole tokens until it occurs once in its file, so the runner never refuses one. The author still fills in each `expect`, and adds what the suggester can't see, such as a value a decision reads.

The first file we pointed it at was its own. At `cb6a231`, the suggester's 140 edits to `scripts/mutate-suggest.ts` left 24 green and 3 stuck in infinite loops. They were real gaps of the same kind as #238's. No test widened a `find` leftwards when nothing was to its right, or rightwards when nothing was to its left. A file with uncommitted changes and no candidates was never tried. Nothing read the `v` flag from a literal, and no test had an alternative inside a lookaround or a `|` in a nested group. Some green ones were equivalent: an unused `open` on the whole-pattern group, a `slice(i, i + 4)` whose `+ 5` changes nothing. Those we wrote out of the code rather than list as survivors. A second pass, at `c71f7ba`, still found gaps across the three scripts: a `.tsx` file parsed as plain TS gave the same edits for our only TSX test, a bare `--` after `--suggest` was never tried, and no journal line had its keyword exactly three words after the number. The edits that remain equivalent (a scanner starting at index `-1`, or running one step past the end of the pattern) are left out of the final runs and named in the PR. The PR's tables are the evidence for the final edits.

The same PR carries the batch's other items:

- **ERROR shows its cause (B9-7).** `mutate` now prints the last five non-empty lines of an errored command's output, so an ERROR row no longer means opening `--json` to learn why (#217's review).
- **ADR checks (B9-3, B9-4).** `scripts/adr-history.test.ts` now covers every ADR with an amendment, not only those whose status starts "Accepted", so ADR-002 is checked again (#228's TEST-2). A new check needs each amendment date in its ADR's status or `**Amended:**` line and in its index row. `docs/adr/README.md` tells an amendment to search the body for each name, count and "only" claim it makes false.
- **Journal counts (B9-6).** `scripts/journal-links.ts` also fails a line in an added entry that states a count of mutation edits or killed ones, or a gate `<n>/<n>` result, without a backticked SHA, an `actions/runs/<id>` link or a `/commit/<sha>` link. Four reviews had found a journal count that a later commit had made stale. This entry follows the rule: each count names `cb6a231`, and the final ones point to the PR's tables.
- **The gate tolerance (B9-5).** Nick generalised #233's decision: a passing `Eval gate` is his advance acceptance of one regressed case per mode. The PR names that case. A decision line is still needed for two or more different regressed cases in a mode, any safety violation, or the same case regressing on two or more gate runs.
- **Scratch paths (B9-9).** `task-worker.md` now says a worker's scratch path is its own, after two parallel workers overwrote each other's files on 2026-10-09.

## Why we chose what we chose

These are the decisions the spec left open, each with the option it beat.

- **What a `find` starts from.** The changed text itself: the operand with its operator for a drop, the operator token for a comparison, the literal for a number, the group for a regex part. It widens from there, so a find stays as short as uniqueness allows. We didn't start from the whole chain or the whole comparison, which reads more easily but gives a long multi-line `find` for a long chain.
- **Which names hold no numbers.** Besides the issue's type positions, enums and property names, a numeric literal that is any declaration's name (a method `1() {}` as well) gets no edit. The check is one comparison, `parent.name === node`. We didn't list property assignments and declarations by kind: the list was longer and caught nothing more.
- **An emptied pattern.** Removing the only lookaround of `/(?=a)/` would leave `//`, a comment, so the edit writes `/(?:)/`. We didn't skip the candidate, since the break is still worth trying.
- **Numbers inside versions, names and dates.** The journal check doesn't count a number joined to what comes before it by a letter, `.`, `:` or `-` (`v1.2 edits`, `file.ts:42 edits`, `B9-1 edits`, `2026-10-11 edits`). A `/` before it doesn't stop it, so `<n>/<n> killed` counts. We didn't read every number in digits as r1/Q-2 (b) words it, because these lines would then each need a SHA for a count that isn't one.
- **The gate's word.** The gate rule needs the word "gate" or "gates", so "investigated" next to an `<n>/<n>` isn't a gate result. We didn't match "gate" anywhere in a word.
- **Infinite loops and equivalent edits.** Edits that stop a loop from advancing (the scanner's `i += 0`, the widening steps' `>=` and `<=`) time out or crash the test run, and a few edits change nothing a caller can see. We leave both out of the PR's tables and list them in the PR instead, rather than listing rows that read ERROR, TIMEOUT or SURVIVED with no test that could change them.

One departure from an owner decision: r1/Q-5's edges ask for a test where `return x >= 0;` twice is "counted on stderr as "skipped 1"". With A-6's number edits, that statement gives three candidates (the comparison and two number edits), so we used `return x >= y;`. The `suggestEdits` test reads a skip count of 1 for one added copy. The `mutate --suggest` test commits both copies as added lines, so its stderr reads "skipped 2". The PR names this under its departures.

## Evidence

- `scripts/mutate-suggest.ts` and its tests; `scripts/mutate.ts` (`--suggest` dispatch, ERROR lines); `scripts/journal-links.ts`; `scripts/adr-history.test.ts`.
- The first self-run, at `cb6a231`: 140 edits, 113 killed, 24 survived, 2 timed out, 1 error. The final runs are the PR's Seen-failing tables.
- No eval run: no agent, prompt, tool or model config changed, so the `Eval gate` passes without Bedrock.
