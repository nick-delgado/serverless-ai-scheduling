# 2026-10-16 — Every expected test goes red: batch 11 closes four gaps the suggester and the PR body left open

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #287, PR #288, #72, #282, PR #266, PR #269, PR #274, PR #275, PR #277, PR #278, PR #281, PR #283, PR #285

## What happened

Process batch 11 (`improve-agent-process` over the first reviews of PRs #269 to #285, and of batch 10's own PR #266) found that missing tests per 1,000 lines had risen again (1.39 to 3.06; 5 of 8 PRs to 7 of 8), although batch 10 gave `--suggest` four new kinds. The breaks the reviewers wrote by hand were shapes the suggester couldn't emit: a regex character class and its anchors (#278), the order of two guards (#281), and an `expect` test that stayed green while a sibling test went red, which `mutate` still counted as KILLED (#274). Deferred work without an issue came back three times after batch 10 put it in words (#266, #283, #285). Two PRs built beyond an owner decision's text and credited the extra to it (#283's two safety patterns, #285's third sign-in route). #266's mutate table didn't fit its PR body, and #278 trimmed its own by hand. And the scenarios README's FR-031 row had drifted from the cases' `covers`.

An agent (Claude, as #287's task worker) built the ten approved items, after Nick answered the readiness review (r1):

- **`PR body` reads the Deferred section.** `scripts/pr-body.ts` fails a list item under `## Deferred / follow-ups` that names no `#<N>` and doesn't say "to file". It shares one section reader with the "Decisions the spec left open" rule, so both skip HTML comments and fenced blocks the same way.
- **`--suggest` gains three kinds.** `regex-class-member` removes each member of a character class with two or more members, `regex-anchor` removes each `\b`, `^` and `$` outside a class, and `swap-guard` swaps two adjacent guards (an `if` with no `else` that ends in `return` or `throw`, braceless or as a block; r1/Q-1 (b)).
- **Every `expect` name must go red.** `mutate` reads a KILLED edit as KILLED-OTHER unless each name in its `expect` matches a failed test.
- **One failed test per table row.** The `--markdown` Failed-tests cell shows the test `expect` matched (else the first failed test) and `(+<n> more)`. The progress lines and `--json` keep them all.
- **The README's coverage rows list their cases.** `scenarios-lint.test.ts` fails when an L1 case that covers one of FR-030…FR-037, or one of the ADR-009 policy keys (Nick's correction to r1/A-12), isn't named as a code span in that row.
- The docs: a decision's rejected alternative is something to break (`CLAUDE.md`), any count a branch's run produced names its commit (`dev-journal`), building beyond a decision's text is a departure (`task-workflow` step 4 and the PR template's comment, r1/Q-4 (b)), and a browser check is one a session has no browser tool for (`task-worker`, `task-workflow` step 7).

## Why we chose what we chose

The issue's "Decisions and clarifications" settled the matchers. These are the decisions the spec left open, each with the alternative it beat.

- **A nested `v`-flag class is read on its own.** r1/Q-2 (a) says a `v`-flag class holding a nested class gets no member edits. We read that of the outer class only, so `[[ab]c]` with `v` still gives the inner class's two edits. The alternative, skipping every class inside it too, would have dropped breaks of a class that holds no nesting itself.
- **The ADR-009 rows follow A-10's code-span rule.** Nick's correction to r1/A-12 asked the lint to check the ADR-009 rows too. With A-10's rule (an exact code span, no glob), the `adr9.escalation` row's `l1-escalate-*` failed, so the row now lists its five cases. The alternative was letting a glob match in those rows only, a second rule for one table. The PR lists this under "Departs from or questions an owner decision", since it goes beyond the two rows the correction named.
- **The lint reads the "Covered by" cell for ADR-009 rows**, the table's only case cell, and L1 cases only, as for the FR rows; multi-turn scenarios there are still named by globs (`book-*`).
- **The Deferred failure names the item and both ways out** ("file one and link its #<N>, or write "to file" and report it"), one line per item, so a PR with three unlinked items gets three lines.
- **`task-workflow` step 7 says the check exists.** Its deferred bullet now ends with what the `PR body` check fails, and that prose isn't read (r1/A-5). The alternative was leaving the rule only in `CLAUDE.md`'s CI bullet.

## What surprised us

- **The new kinds broke the suggester's own regexes first.** On this branch, `--suggest` proposed class-member edits for the escape pattern in `escapeLength` (`[pPu]`, `[\da-fA-F]`, `[a-zA-Z]`), the very code that reads classes. A regex kind tests its own source.
- **The first mutate pass found the class reader's edges untested.** The breaks that survived it were all in `characterClass` and `escapeLength`: an unterminated class (`[ab-`, which no regex literal can hold but `regexParts` accepts), `--` without the `v` flag, a nested class that itself holds `&&`, an escape read from the middle of the class (the `^` anchor on `escapeLength`'s own pattern), and uppercase hex digits. Each got a test case. Two breaks (an atom of length 0, and no end-of-pattern check) make the reader loop until the Vitest worker runs out of memory, so `mutate` reads them as ERROR rather than KILLED, and three are equivalent: two swap independent statements, and one rereads the second `&` of `&&` with the same result. The PR's table lists all five.
- **#278's class stays out of reach.** Its sentence-end class now lives in a string, ``new RegExp(`[${SENTENCE_END}]`)`` (`packages/evals/src/graders/text.ts:246`), and `--suggest` reads regex literals only, so the motivating case of B11-2 gets no edit even now (r1/E-3).

## Evidence

- Seen failing: the `npm run mutate -- … --markdown` tables in PR #288's body (`--suggest` against `origin/main`, plus hand edits for each decision's rejected alternative).
- The new lint tests, before the README fix (`506bf1c`), reported FR-031 without `l1-book-confirmed-plain-text`, `adr9.confirm-before-write` without the same case, `adr9.no-invented-facts` without `l1-book-after-explicit-yes`, and each `l1-escalate-*` case missing from `adr9.escalation`, whose cell named them by glob.

## What's next

- The batch record goes on #72, with whether `swap-guard`, the regex kinds and the every-`expect` rule cut `test-cannot-fail` in the next window.
- #282 carries #283's P1 (only safety cases use L1's safety-counted text checks) and may change an `l1-offer-*` case's `covers`; the new lint then names any row to fix.
