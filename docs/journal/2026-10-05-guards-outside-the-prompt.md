# 2026-10-05 — What the prompt couldn't stop, code now removes: `<thinking>` anywhere, and IDs in escalation summaries

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M3
**Related:** #107, #16 (PR #102), #37, ADR-008, ADR-009, ADR-010, PRD FR-034

## What happened

System prompt v1 (#16) took Sonnet 4.6 to 66 of 66 L1 trials, but Nova Pro kept three safety violations in 66 trials that no prompt wording removed ([the v1 entry](2026-10-02-system-prompt-v1.md)): `<thinking>` leaked into the visible reply twice on `l1-escalate-billing`, and once it put a UUID the patient typed into an `escalate_to_human` summary. ADR-009 says violations a prompt can't fix go to measures outside the prompt, so #107 added two code guards. An agent built both; Nick settled the open questions on the issue before work started (readiness review round 1, every recommendation accepted).

1. **The `<thinking>` filter now works anywhere, for every profile.** `ConverseLlmClient` already had an `InlineReasoningFilter`, but it only split off a section at the *start* of a text block. It now removes every tagged section wherever it sits, matching tags the way the `no_reasoning_leak` grader does (any case, spaces, attributes, a stray closing tag). `<thinking>` is stripped for every profile, plus the profile's own tag (gpt-oss: `<reasoning>`). Profiles with a tag keep the removed text as a reasoning block; Claude and Nova 2 Lite drop it, because the loop replays reasoning to Claude and Claude rejects a reasoning block without its signature (ADR-010).
2. **The escalation summary can't carry an ID.** Before `escalate_to_human` records the escalation, every GUID, `appt_`/`slot_`/`prov_`/`esc_` ID and `pat-` alias in the summary becomes `[ID removed]`. The stored record, the staff email and any retry re-send all read the cleaned text. The guard never rejects, so the patient always gets the phone number and hours.

## Why we chose what we chose

Settled by Nick on #107 (round 1): the filter lives in the client, not the loop (L1 calls the client directly, so only a client-side strip changes the L1 result); `<thinking>` for every profile as one constant rather than a list type that would ripple into #105; redaction with a placeholder, never rejection; patterns in the handler, not `packages/contracts`; no Bedrock Guardrail yet. The summary guard can't move the `l1-patient-id-injection` number, because L1 grades the model's raw tool input and runs no tools, so its proof is the unit tests and #37 keeps counting that case.

The spec left these open; the agent decided them while building:

- **Whitespace around a removed section.** While nothing visible has been shown, whitespace before and after a section goes with it, so a reply never starts with blank lines (the old behaviour). Mid-text it is kept, so "Sure. `<thinking>…</thinking>` I'll connect you." shows "Sure.  I'll connect you." with two spaces. Collapsing it would mean guessing at markdown; a double space renders as one.
- **A section closes only at its own closing tag.** `</reasoning>` doesn't close `<thinking>`, and `</thinkingly>` doesn't close anything. The alternative (any stripped tag closes any section) would let a stray close leak the rest of a section.
- **A full tag name with no `>` yet is held back until the `>` or the end of the block.** At the end, held text that never became a tag is shown (`Hi <thinking about it` stays visible). The grader only counts a tag with its `>`, so this agrees with it. Releasing the text earlier would risk streaming the start of a real tag.
- **Several sections in one block go into one reasoning block, joined by a blank line; empty sections are skipped.**
- **Tag names are word characters, so they aren't regex-escaped.** All profile tags are; escaping would be code no test can reach.
- **Every ID pattern is case-insensitive** (the spec said so for GUIDs). A typed `APPT_123` or `PAT-Walter` is as much an ID as the lower-case form.
- **The 1,000-character cap can cut a placeholder in half.** It only bites when a summary near the limit is full of short IDs (each grows to 12 characters); the alternative was rejecting, which the spec rules out.
- **Accepted false positives:** `pat-` followed by letters is redacted as a whole word, so "a pat-down" becomes "a [ID removed]". Staff lose a word; a missed ID would be worse.

## What surprised us

- **The patient simulator gets the filter too.** The evals' simulator calls the same `ConverseLlmClient`, so a simulated patient's `<thinking>` is now stripped as well. That's the right outcome (a simulator leak was noise), but it's a side effect nobody asked for.
- **Two of the first checks were dead code.** Breaking the filter one piece at a time showed a `>` check and a "next character isn't a word character" check that no input could ever reach, because the regex before them already guaranteed both. We deleted them instead of writing tests that couldn't fail.

## Evidence

- Mutation checks, one break at a time, each run against the test file: 38 breaks of the filter (each tag-regex part, each part of the partial-tag check, both case flags, each `||`/`&&` operand, the hold-back, the profile-tag and always-`thinking` parts of the tag set, keep-vs-drop of the removed text) and 22 of the summary guard (each pattern, each prefix, each flag and word boundary, the placeholder, the cap, the call itself) all turned a test red. One break (keeping held whitespace when a tag is removed before anything is shown) is equivalent: the next visible text is trimmed anyway.
- L1, three trials, on `nova-pro` and `sonnet-4.6`: *pending; the numbers go here, in the PR and on #37.*

## What's next

- #37 scores Nova Pro with these guards in.
- If the L3 red-team set shows violations code guards can't reach, revisit a Bedrock Guardrail (ADR-009).
