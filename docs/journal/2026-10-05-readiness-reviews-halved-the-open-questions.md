# 2026-10-05 — Readiness reviews halved the open questions, and wrote some of the next mistakes

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #156, issue #72 (batch 5 record), practice B4-1, PRs #152, #153, #154, #155, issues #113, #157

## What happened

Wave 4 (#99, #104, #28 and #140) was the first in which every issue had a readiness review (`review-agent-issue`) before an agent started on it. Nick answered each review's questions on the issue, and the apply step wrote the answers into the description. After the four PRs merged, the orchestrating session ran `improve-agent-process` (batch 5), which first measures what earlier batches changed and then picks new changes.

The measurement compares the first reviews of the 21 PRs before batch 4 (about 33.3k changed lines, 271 findings above nit) with the 4 wave-4 PRs (3,655 lines, 37 findings). Questions the spec left open, which the owner then had to decide on the PR (`spec-open`), fell from 1.14 to 0.55 per 1,000 changed lines, in 2 of 4 PRs against 19 of 21. That is what readiness reviews were for, and it worked.

Every class that earlier batches had addressed only with written rules stayed flat or rose: tests that couldn't fail (1.65 → 1.92), claims beyond the evidence (0.45 → 1.92), stale restatements (0.51 → 0.82), duplication (0.90 → 0.82). The guardrails held: no ADR was rewritten in place, and no real-clock read came back.

Nick approved four changes in #156:
- one list of open decisions;
- a guardrail for restatements kept in sync;
- a note at the `?raw` test precedent;
- an update to the #113 mutation trial.

He also approved filing #157 for one shared template-as-text test helper.

## Why we chose what we chose

The decisions this batch left open, each with the alternative it beat:

- **One list of open decisions, in the journal entry.** The PR template links to it rather than repeating it (it beat a CI check that compares the two lists). The journal missed decisions the PR body listed in 3 of 4 PRs, each time because it was written before the PR body's list was final. A second copy drifts; removing it costs nothing. Comparing the two lists would need the PR body, which isn't in the repo.
- **A marker-based guardrail for restatements**, `scripts/sync-regions.test.ts` (it beat another sentence in `task-workflow`, and a broad search for stale wording). Written rules for this class have now failed three times. Markers only guard the pairs someone marks, so the check starts with the two pairs that drifted in this wave: the chat-turn order (#153) and the CI description (#155). A `Sync-checked: <name>` commit trailer covers a change to one copy that leaves the other true.
- **A comment at the precedent, not a rule in the skills**, for `?raw` (it beat a line in `apps/web/README.md`). The readiness review on #28 pointed at `tokens.test.ts`'s `?raw` import as the pattern to follow, and it can't work for other CSS files. A comment where agents copy from is read at the moment it matters.
- **No new words for tests that can't fail or claims beyond evidence.** That work goes to the #113 trial instead (it beat a ~200-line break-generator script now). #113 already measures Stryker and an exact-edit runner, and this batch added this wave's misses to its comparison set. Removing the definition of done's list of what to break, which has failed twice, waits for #113's result, so the list is not dropped before something mechanical replaces it.

## What surprised us

Seven of the 37 wave-4 findings trace back to text the readiness review itself wrote, or that its apply step dropped:
- a prescribed test mechanism that couldn't work (`?raw`);
- tests named by mechanism instead of by what they should observe;
- a fallback that was in the accepted recommendation but not in the option's text, which is all the apply step records;
- a "copy the existing slicers" assumption.

The review moved the questions forward. It also became a source of the spec the agent follows, and of the spec's mistakes. Those fixes belong to the review skill, so they're listed for the harness maintainers in the batch record on #72.

## Evidence

- Batch 5 record and the measurement table: #72.
- The guardrail, seen failing on planted defects (`SYNC_BASE` set to the commit with the markers):
  - changing only `docs/architecture.md`'s chat-turn region fails, naming `services/api/src/lib/chat-turn.ts`;
  - removing a `sync-end` marker fails with "has no sync-end";
  - changing both copies passes;
  - a one-sided change in a commit with `Sync-checked: chat-turn-order` passes, and the same commit without the trailer fails.
- 13 exact-edit breaks of the guardrail's own logic each turn a test red (listed in the PR). Renaming the trailer key goes red only with a trailer commit in range.

## What's next

- #113 decides whether a mutation runner replaces the written list of what to break.
- The next batch measures B5-1 (journal decisions) and B5-3 (sync regions), and B4-1 again with more than four PRs.
