# 2026-10-05 — One copy of the model-call plumbing: the throttle rule, the request builder, the usage sums and the retry loop

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #105, PR #175, #85, #17 (PR #96), #31 (PR #97), #32 (PR #165), ADR-001, ADR-007, ADR-008, ADR-010, PRD FR-015, FR-040

## What happened

Three agent PR reviews (#96, #97, #165) each found a piece of model-call plumbing that two or more packages kept their own copy of, and the copies had already drifted:

- **Which errors are throttling.** The chat handler (`classifyAgentError`) and the eval harness (`isThrottle`) each kept a name set and a status lookup. The API counted `ServiceQuotaExceededException` and read only `$metadata.httpStatusCode`; the evals counted `Throttling` and also read `statusCode` and `status`. One Bedrock error could be "the assistant is busy" (429) to a patient and a non-retried `error` to the harness, or the other way round.
- **Turning a model profile into a request.** The loop, L1, the patient simulator and the judge each copied `modelId`, `family`, `maxTokens`, `modelFields` and the optional inline reasoning tag, and placed the system cache point themselves. The simulator and the judge didn't place it at all.
- **Token-usage sums.** `zeroUsage`/`addUsage` existed in the loop and again in `packages/evals`.
- **Retry-with-feedback.** The simulator and the judge each ran the same loop: call, parse, feed the problems back, record the rejected reply, add up the cost, throw an error carrying it.

An agent made each of these one shared copy in #105. Nick settled the two open questions on the issue before work started (readiness review round 1, every recommendation and assumption accepted):

1. **`isThrottle` and `httpStatusOf` live in `@sched/agent`** (`throttle.ts`), with the **union** of the two name sets: `ThrottlingException`, `TooManyRequestsException`, `ServiceQuotaExceededException`, `Throttling` (r1/Q-2). The status lookup is the evals' order, `$metadata.httpStatusCode ?? statusCode ?? status`, and the name is read from any object, not only an `Error` (r1/A-2, A-3).
2. **`classifyAgentError` moved out of `errors.ts`** into `services/api/src/lib/agent-errors.ts` (r1/Q-1). The session Lambda imports `errors.ts` and must not bundle `@sched/agent` (`test/session-bundle.test.ts`), so `errors.ts` keeps only `FAILURES` and `ChatFailure`, and only the chat turn imports the new file.
3. **`profileRequest(profile, {stable, dynamic?}, {maxTokens?})`** in `@sched/agent` returns every `LlmRequest` field except `tools` and `messages`. The loop passes its current profile and `max_tokens` retry cap; L1, the simulator and the judge pass their own system text. The rolling message cache point stays in the loop.
4. **`zeroUsage`/`addUsage`** are exported from `@sched/agent`; `packages/evals` has no copy left.
5. **`callWithFeedback`** (`packages/evals/src/feedback-retry.ts`) is the one retry loop; the simulator and the judge pass their attempt counts, parsers, error classes and exhaustion messages.

### What changes for callers

- **Classification.** The API now answers 429 "busy" for an error named `Throttling`, and for a 429 found in `statusCode` or `status`, or on a non-`Error` object with a throttling name; before, all three were 503 "temporarily unavailable". The eval harness now retries `ServiceQuotaExceededException` with backoff and counts it in `throttles`, where before it ended the trial at once as `error`. Neither side loses a name it recognised.
- **Requests.** When a profile sets `cachePoints.system` (Claude, Nova), the simulator's and the judge's requests now carry a system cache point after their system text. That is the only request change: the loop and L1 requests are unchanged, and their existing tests pass unmodified. A system prompt shorter than the profile's `minCacheableTokens` silently caches nothing, so this is a request change, not a measured saving.

## Why we chose what we chose

The two questions Nick answered are in the issue's "Decisions and clarifications". The spec left these open; the agent decided them while building:

- **Names.** The builder is `profileRequest` in `packages/agent/src/llm/request.ts` (beside `LlmRequest`), with its `maxTokens` override in an options object, so a later option doesn't reorder arguments. The status lookup is exported as `httpStatusOf` (a package export needs a more specific name than the evals' private `statusOf`), and `THROTTLE_NAMES` is exported too, so the test can pin the whole set.
- **Usage sums in their own leaf module** (`packages/agent/src/usage.ts`), not in `loop.ts`, so importing them doesn't mean importing the loop.
- **The retry helper builds both failure messages itself.** The caller passes only the start of the exhaustion message (`no usable patient reply in 3 attempt(s)`, `no valid verdict in 2 attempts`), and the helper appends the problems, joined with ", " within a reply and " | " between replies. That keeps one copy of the joining format, which Stryker had found unpinned in the simulator's copy (#108's list). The `model call failed: <Name>: <message>` text is built there too. Both messages are verbatim what each caller produced before.
- **The simulator's error factory drops `rejected`.** `SimulatorError` never carried the rejected replies, and still doesn't; the judge's `JudgeError` still does, on both kinds of failure.
- **The retry helper's cost type is the existing `SimulatorCost`** (the judge's `JudgeCost` is an alias of it), so no new type crossed into `packages/evals`' public shapes; the helper isn't exported from `@sched/evals`.
- **`rate-limit.ts` reads the error name inline** for its transient-name check, and lost its private `field` and `statusOf`; it re-exports `isThrottle`, so `@sched/evals`' surface and its tests are unchanged (r1/A-4).
- **ADR-008's note on the L1 parity test** got a one-sentence status update saying #105 did the work, rather than an amendment section, because no decision changed.

## What surprised us

- **A syntax error counted as a kill.** The agent's first mutation pass (`npm run mutate`, #113) broke `httpStatusOf`'s `??` chain by turning one `??` into `||`. JavaScript forbids mixing the two without parentheses, so the edit didn't compile. Vitest couldn't load `throttle.test.ts`, and the runner rightly doesn't count a file that fails to load. But `session-bundle.test.ts` bundles the chat handler with esbuild, and esbuild failed on the same syntax error, so the run had one failing test, and the edit printed `KILLED`. The failing test named was the bundle test, not a throttle test, and that mismatch was the clue. Rewritten with parentheses (`(httpStatusCode || statusCode) ?? status`), both breaks went red in the test meant for them. A `KILLED` line is evidence only when the failing test is one that checks the line.
- **The loop and L1 tests needed no change at all**, and the L1 parity test lost most of its checks. Once both build the profile-derived part with the same function, comparing those fields compares a function with itself; what can still drift is each caller's own part (L1's tools and messages), so that is what the parity test keeps.

## Evidence

- **Seen failing:** 83 exact edits to the code this issue wrote or moved (`throttle.ts`, `llm/request.ts`, `usage.ts`, `feedback-retry.ts`, and the call sites in the loop, `agent-errors.ts`, `rate-limit.ts`, `l1.ts`, the simulator and the judge), each applied alone with `npm run mutate`: all 83 killed, by a test that checks the edited line. The PR lists each edit and the test that went red.
- **Tests:** `npm run test:coverage`: 101 files passed, 3 skipped; 2,253 tests passed, 111 skipped. `npm run coverage:changed`: every added source line ran in a test. The session-bundle test still keeps `@sched/agent` and the Bedrock client out of the session Lambda.
- **Eval smoke runs:** in the PR (`--dry-run` estimates on `sonnet-4.6`: L1 $0.14, scenario $2.73 with the judge).

## What's next

- The eval smoke runs (L1 and scenario, `sonnet-4.6`, branch and `main`) go in the PR.
- Not checked, and out of scope: what HTTP status Bedrock gives `ServiceQuotaExceededException`, and whether an in-stream `throttlingException` event reaches `isThrottle` with its name (`ResponseAssembler` wraps a non-`Error` event as a plain `Error`, whose name is `"Error"`). If a live run shows the second, it is a follow-up issue.
