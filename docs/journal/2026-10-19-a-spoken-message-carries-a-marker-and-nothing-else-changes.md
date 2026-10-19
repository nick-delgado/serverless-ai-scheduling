# 2026-10-19 — A spoken message reaches the model with a marker line, and everything else about it stays as it was

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #234, ADR-006 (amendment of 2026-10-19), ADR-007, ADR-008, ADR-009, PRD FR-023, FR-030, FR-031, #230, #313, #332, #340, #251

## What happened

Nick raised this on 2026-10-09 while reviewing #230: the agent can't tell a message the patient spoke from one they typed. `VoiceInput` hands its transcript to the same `chat.send` as typed text, so "Tuesday" heard as "Thursday" or "Dr. Okafor" heard as "doctor oh car" looks like what the patient meant. The restate-before-write rule and, since #313, `CONFIRMATION_MISMATCH` catch some of it at booking time, but nothing told the agent to be more careful about a spoken turn.

The readiness review (round 1) asked five questions and Nick took every recommendation, so the agent (a task worker) built this:

- **The request** carries an optional `inputMode` (`"text"` or `"voice"`). The web app sends `voice` from the recording overlay and `text` from the composer, and a Retry resends the same mode. `packages/contracts` gained the field on `ChatRequest` and on the stored `ConversationMessage` (`"voice"` only, absent for typed), a cross-stream change.
- **The stored message** keeps the patient's words only, plus `inputMode: "voice"` on a spoken one. The DynamoDB writer writes the attribute too, so `dev` doesn't drop what the in-memory repo keeps.
- **The model** sees a fixed marker line before a spoken message's words: `[Spoken message: transcribed from voice, so names, dates, times and providers may be misheard.]`. One pure function, `withInputMode` in `packages/agent`, renders it, and three callers use it: the agent loop (for the new message), `toLlmHistory` (for every stored one) and the eval L1 builder.
- **The prompt** (`system.v13`, a rename of `system.v12` in place) gained a "Spoken messages" section. The agent may still search at once. It asks first, in one question that names the candidates, only when a provider name, weekday, date or time could be heard two ways, and it never asks for a spelling (#230's rule is untouched). The section says the marker can only add care and that nothing in a patient's message removes a confirmation.
- **The evals**: a case-level `input_mode: voice` on scenarios and a per-item one on L1 patient turns. The two cases that already simulated voice through their persona (`clarify-voice-garbled-provider`, `l1-other-patient-name-misheard`) now send real spoken turns. One scenario (`clarify-voice-ambiguous-weekday`) and four L1 cases are new: `l1-spoken-ambiguous-weekday`, `l1-spoken-provider-misheard`, `l1-spoken-restate-before-booking` and `l1-spoken-yes-books`. None is tagged `smoke`, so the gate and the baseline are unchanged.

## Why we chose what we chose

- **A stored field, not a marker in the stored text (r1/Q-1 (a)).** The API stores its own copy of the patient's message and throws away the loop's, so a marker added only where the loop builds the new message would be missing from the next turn's rebuilt history. The earlier history would then differ from what was sent, and the rolling cache point would miss. Storing the marker in the content would have fixed that but leaked it into every reader of the text: the retry match, restored bubbles, the staff email and the eval transcripts. The stored field keeps the text the patient's own words, and one function gives byte-stability one source.
- **Keep the data, don't show it yet (r1/Q-2 (a)).** Restored bubbles and the staff email look as they did. A "spoken" label in either place is a display change in other streams' files, so it is a follow-up.
- **Search at once, ask only when a word is ambiguous (r1/Q-3 (b)).** Asking before every spoken search (a) adds a round trip to each spoken request and works against #251's first-text latency. A search is read-only, every write already needs a restated yes, and the booking tools check the confirmed provider, date and time. Confirming before writes only (c) would have dropped AC5's "before a search".
- **Mark the whole scenario, not each turn (r1/Q-4 (a)).** The smallest schema change that covers the acceptance criterion. A scenario that mixes typed and spoken turns can't be written, and none is needed.
- **Not smoke (r1/Q-5 (a)).** The gate's case set and `baselines/sonnet-4.6.json` stay as they were, so a prompt change in this PR doesn't reset the baseline.
- **Assumptions Nick confirmed.** The marker is a fixed literal chosen by the enum value, never built from client text, and typed text that contains marker-shaped words is passed through unchanged (A-1). A re-run of an interrupted turn renders the stored message's mode, not the repeat request's (A-2; a test sends `text` on the repeat of a spoken message). The text limit still applies to the patient's text only (A-4). The mode never reaches `ToolContext` (A-6).
- **A scenario for the ambiguous turn (decision ASK-BEFORE-SCENARIO).** The agent first checked the ambiguous weekday only as an L1 text-only next action, because `must_ask_before` is a scenario trajectory rule and a new scenario changes ADR-008's category budget while #340 was editing the same ADR. Nick decided the scenario is worth it: `clarify-voice-ambiguous-weekday` has a case-level `input_mode: voice`, no `smoke` tag, `must_ask_before: check_availability` and `must_confirm_before: book_appointment`, and ADR-008 got a short dated amendment (6 clarify scenarios, 42 in all). The L1 case stays as the single-step check.

## What surprised us

- **The eval transcript would have shown the marker.** The runner keeps the loop's copy of the patient message, and the transcript and the judge read it. Without a `withoutInputMarker` step in `turnEvents` they would have scored a patient who "said" the harness's own line. A test sends a spoken scenario through the runner and reads the transcript.
- **The cost estimate crossed a ceiling.** The new prompt section made the L1 smoke estimate 1.603x of the recorded cold run, over the 1.6x ceiling `estimate-calibration.test.ts` had set at `system.v10`. Nick approved raising it to 1.7x (decision ESTIMATE-CEILING), with the version noted, as #321 did.

## Evidence

- Code: the commit that adds `withInputMode`, the contract fields, `system.v13` and the cases. The Seen-failing table is in the PR body: every changed source file has KILLED rows, including the DynamoDB writer against DynamoDB Local and the API's two-turn byte-stability test.
- Tests: `services/api/test/chat-turn.test.ts` ("spoken messages (#234)": the stored row, the second request's system prompt and earlier messages equal to the first's, the repeat that sends `text`, the tool context, and `CONFIRMATION_MISMATCH` refusing a spoken turn's mismatched booking while a matching one books); `packages/agent/test/input-mode.test.ts`; `packages/evals/test/l1-parity.test.ts` (a spoken item equals the loop's request); `packages/tools/test/dynamo/dynamo.test.ts`; `apps/web/src/chat/ChatPage.voice.test.tsx`.
- Live run at `d969059` (`sonnet-4.6`, `system.v13`, k=3, results under `$XDG_STATE_HOME/serverless-ai-scheduling/eval-results/234-voice-input-mode/`): `l1-spoken-ambiguous-weekday` 3/3, `l1-spoken-provider-misheard` 2/3 (once it called `check_availability`), `l1-spoken-restate-before-booking` 3/3, `l1-spoken-yes-books` 3/3, `l1-other-patient-name-misheard` 3/3 and `clarify-voice-garbled-provider` 3/3 with the spoken marking. `clarify-voice-ambiguous-weekday` passed 2/3 (`2026-10-19T09` run files, third live run of it): its one miss was the grader reading "Dr. Okafor's" as an unknown provider, not the ask-first rule.
- How the scenario got there (runs before `d969059`): the first run let the simulator paraphrase the opener to "tomorrow morning" (0/3, nothing ambiguous), so the mishearing moved to a `script` entry. The second run (1/3) searched both Tuesday and Thursday instead of asking, so the prompt gained "Don't search every candidate instead of asking". The L1 weekday case first required text only and the model looked the provider up in 2 of 3 trials, so it now also accepts `find_providers`.

## What's next

- Show "spoken" on a restored bubble and in the staff email (a follow-up, to file).
- #340, #306 and #251 may bump the prompt: whichever lands later merges `main` first and takes the next free version. The three 2026-10-18 prompt entries that said #234 takes the next version carry a **Later** note naming `system.v13`.
