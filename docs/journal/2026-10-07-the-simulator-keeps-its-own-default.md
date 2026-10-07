# 2026-10-07 — The patient simulator keeps its own default, and a bad simulator setting only breaks the runs that use it

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #108, PR #209, #31 (PR #97), #32, #37, #169, ADR-008, ADR-010

## What happened
The full review of PR #97 (the patient simulator, #31) noticed seven things in code its review round hadn't touched. None blocked #97; #108 collected them, and Nick settled its three open questions before work started (r1/Q-1 to Q-3). An agent (Claude, as a task worker) built it.

- **Its own default.** When neither `--simulator-profile` nor `SIMULATOR_MODEL_PROFILE` names a profile, the simulator now runs on `DEFAULT_SIMULATOR_PROFILE` (`sonnet-4.6`, in `packages/evals/src/simulator/llm.ts`), not on the agent's `DEFAULT_MODEL_PROFILE`. When the M3 matrix (#37) picks a new agent default, the simulator, and with it ADR-008's exit-metric runs, stays where it is.
- **A stale variable no longer breaks other runs.** `parseCliArgs` used to resolve the simulator profile on every run, so a leftover `SIMULATOR_MODEL_PROFILE=gpt-9` in a shell broke an L1 run that never calls the simulator. The simulator now follows the pattern the judge already used (#32's r1/A-10): `parseCliArgs` keeps the unresolved name and the flag or variable it came from, and `simulatorSetup` resolves it only for an LLM-simulated scenario run. L1 runs, `--replay` runs and both calibration steps ignore a bad value.
- **Errors name the setting that supplied the value.** Every CLI profile error used to say `Unknown AGENT_MODEL_PROFILE "…"`, even for `--simulator-profile` or `JUDGE_MODEL_PROFILE`. They now name `--profile`, `--simulator-profile` or `SIMULATOR_MODEL_PROFILE`, `--judge-profile` or `JUDGE_MODEL_PROFILE`, whichever supplied the value (Nick's r1/Q-3 (b)).
- **Tests that were missing:** the default escalation allowance of two messages (TEST-103), replay keyed on the scenario as well as the trial (TEST-104), `(none)` as the content of an empty `## Private facts` section (TEST-105), and the run summary's simulator cost summed over trials with no simulator line in L1 markdown (TEST-202). Six Stryker survivors in the same code (r1/Q-1 (b)) got tests too.
- **ADR-008** said an unrecorded replay turn stops "the run"; the code stops that conversation only. Following Nick's r1/Q-2 (a), the line keeps its wording with a pointer, and a dated amendment states what replay does.

## Why we chose what we chose
These are the decisions the spec left open, each with the option it beat.

- **The parsed setting is `{ name, from }`, not a bare string.** Assumption A-3 described `CliArgs.simulatorProfile` as the unresolved name (`string | undefined`). To name the right setting in the error (r1/Q-3), `simulatorSetup` and `judgeSetup` also need to know where the name came from, and they never see `argv` or the environment. So `simulatorProfile` and `judgeProfile` are now `ProfileSetting` objects. The other option, a second `…ProfileFrom` field beside each name, would have kept two fields in step for no gain.
- **`cli-args.ts` checks the name itself instead of wrapping `resolveModelProfile`.** The agent package's error text names `AGENT_MODEL_PROFILE`, and `packages/agent` is outside #108's owned paths. Rewriting that text with a string replace would break silently if the message changed. The local check uses `@sched/agent`'s own `isModelProfileName`, `MODEL_PROFILES` and `MODEL_PROFILE_NAMES`, and only the wording is local. Like `resolveModelProfile`, it trims the name and reads an empty one as the development default.
- **The judge's empty-value quirk stays** (A-4): `JUDGE_MODEL_PROFILE=""` still resolves to `sonnet-4.6`, not the judge's `haiku-4.5`. For the simulator, A-4 asked for an empty or whitespace-only value to mean `DEFAULT_SIMULATOR_PROFILE`, so `simulatorSetup` checks for that before resolving.
- **TEST-105 is its own test.** It reads the text between `## Private facts` and the next heading and checks that the last line is `(none)`. Before, the test checked only that the heading was there, and the heading always is.
- **Stryker 224 is equivalent.** That mutant changes `messagesSinceEscalation`'s `e.kind === "tool_call"` to `true`. Only tool-call events carry `name` and `ok`, so for every other event kind `e.name === "escalate_to_human"` is already false. A test would need a malformed event. The other six survivors Q-1 named (232, 240, 395, 417, 421, 423) each have a test seen failing.

## What surprised us
The criterion this issue exists for can't be seen failing with a test today. The simulator's default and the agent's default are both `sonnet-4.6`, so replacing `DEFAULT_SIMULATOR_PROFILE` with `DEFAULT_MODEL_PROFILE` passes every test. The test names therefore claim only the value. We checked the independence by hand, by setting the agent's default to `haiku-4.5` for one run. The simulator still came out `sonnet-4.6`. With the empty-value check also removed, an empty `SIMULATOR_MODEL_PROFILE` followed the agent to `haiku-4.5`, and the test failed. The real test of this will come when #37 changes the agent's default.

## Evidence
- `npm run mutate` with 21 exact edits (the PR body has the table), all `KILLED` by the test named in their `expect`: the default's value, resolving the simulator profile in `parseCliArgs` again, each of the error-source and precedence branches, `?? 2` changed to 1 and to 3, the trial-only replay key, `"(none)"` → `""`, a last-trial-only reduce, the simulator line printed in L1 markdown, and Stryker 232, 240, 395, 417, 421 and 423.
- The hand check: `DEFAULT_MODEL_PROFILE = "haiku-4.5"` in `packages/agent/src/profiles.ts` → `is sonnet-4.6 when neither …` and `is independent of the agent's --profile` both pass (2 passed). After also dropping the empty-value check in `simulatorSetup`, `is sonnet-4.6 when neither …` fails with `expected { name: 'haiku-4.5', … } to be { name: 'sonnet-4.6', … }`. Both files were restored afterwards.
- No live eval run (r1/A-9): nothing the agent, its prompt, its tools or its model profile uses changed, and the simulator resolves to `sonnet-4.6` before and after.

## What's next
- #37: when the matrix picks a new agent default, the simulator stays on `sonnet-4.6`, and that run is the first one where the default's independence shows.
- #169: the remaining Stryker survivors in the simulator code.
