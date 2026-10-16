# 2026-10-16 — A prompt bump now stays in `prompts/`: the tests outside it ask the factory for the version

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #299, #264, PR #302, PR #294 (review finding `a323bce/SMELL-1`), #249

## What happened

The v3→v4 bump (`1a2bb07`) and PR #294's v4→v5 bump each edited the same eight files. Three were in `packages/agent/src/prompts/`: the two version files, and `index.ts`, which renamed version-suffixed re-exports that nothing imported. The other five were outside `prompts/`, and none of their edits changed behaviour. Each rewrote a literal `"system.vN"` pin, a comment or a test name: `packages/evals/test/suite.test.ts`, `packages/evals/test/system-prompt.test.ts`, `packages/evals/test/calibration.test.ts`, `services/api/test/chat-handler.test.ts` and the harness's header in `packages/evals/src/system-prompt.ts`. Four more bumps are queued (#234, #251, #284, #293). Each would have repeated that work and conflicted with the others on the same lines. PR #294's review flagged it, and Nick filed #299.

The agent made three changes in `d8bcbf8`:
- `prompts/index.ts` drops the four re-exports nothing imports (`ESCALATION_MESSAGE`, `SYSTEM_PROMPT_V5_VERSION`, `renderSystemPromptV5Dynamic`, `systemPromptV5`). It keeps `buildSystemPrompt` and `type SystemPromptContext`, and its header now says a bump changes only files in that directory.
- The three pins outside `prompts/` compare against `buildSystemPrompt(...).version`, as `calibration.test.ts` already did. The chat-handler test mocks `@sched/agent`, so it gets the real function through `vi.importActual`.
- The comments and the chat-handler test name no longer say "v5".

The one literal pin left is `system.v5.test.ts`'s "is the current prompt, and its version is recorded in the turn trace". That pin is the one a bump is meant to edit.

The same PR carries #264, a stale doc comment on the DynamoDB tests' `conflictingTwice` helper. The fix is its own commit, `cbe78b2`. It rode along because any change under `packages/tools/` reruns the Eval gate, and this PR runs the gate anyway.

## Why we chose what we chose

The readiness review settled most of it. Nick took no guard test (r1/Q-1 (a)), so the tree is cleaned once and checked with a grep. The rest of the shape is r1/A-1 to A-4. Here is what the spec left to the agent:

- **Which date the derived pins pass.** A-3 says to build the prompt with "the file's date", but `suite.test.ts` and `chat-handler.test.ts` have no date constant. The agent passes `2026-10-05T13:00:00Z`, the date `calibration.test.ts` and `system-prompt.test.ts` already use. The version doesn't depend on the date. A new shared constant was the alternative, and it was rejected because the only shared helper file (`packages/evals/test/helpers.ts`) belongs to #296.
- **`export type { SystemPromptContext }` rather than a one-item `export { type … }` block.** It is the shorter form of the same re-export, and lint accepts both.
- **The harness header drops `#249` too (Nick's decision on PR #302's review, `fd7c85b/SPEC-1` (b)).** r1/A-4 dropped only "currently `system.v5`," from `packages/evals/src/system-prompt.ts`'s header, and the agent kept "#249". The review found that every bump had rewritten that issue number along with the version, and #284's owned paths won't let the next bump touch the line. The parenthesis now reads "(`buildSystemPrompt`, #16)", like `calibration.test.ts`'s comment. Keeping `#249` as a historical citation was the alternative.
- **The header sentence (r1/A-7 suggested it).** It names `system.vN.test.ts` as the home of the one literal pin, so the next bump's agent knows which test should go red.

## What surprised us

How little needed to move. Row 1 of the PR's mutate table, run on `d8bcbf8`, makes `buildSystemPrompt` report `system.v4` across all four affected test files. Only the `system.v5.test.ts` pin failed. The two evals pins and the chat-handler pin passed, because they now read the version from the same factory. That is the behaviour #299 asked for, shown by the mutation rather than argued.

## Evidence

- The PR's Seen-failing table (on `d8bcbf8`) reuses PR #294's P14, P11 and E1 rows, and adds one row that makes the chat handler record `system.v0`. The rewritten chat-handler test goes red on it.
- `git grep -n 'system\.v[0-9]' -- packages services ':!packages/agent/src/prompts'` on `d8bcbf8` prints no `system.v5` line. Every line it prints names `system.v0` to `system.v3`: fixtures, baselines, `transcripts.json` and changelog-style comments. The PR quotes the output.
- No doc lists a bump's files. The PR names the search: `CLAUDE.md`, `.claude/`, `.agents/`, `.github/`, and `docs/` outside the journal.

## What's next

- The next bump (#234, #251, #284 or #293) should touch only `prompts/`. If it touches anything else, that is a regression of this change.
- `packages/evals/src/suite.ts` still calls the default prompt "the interim prompt". The default has been the production prompt since #16. That fix is to file.
