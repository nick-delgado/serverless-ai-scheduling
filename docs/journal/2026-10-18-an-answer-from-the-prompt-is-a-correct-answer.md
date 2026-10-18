# 2026-10-18 — `clarify-unsupported-specialty` stops demanding `find_providers`: a correct "we don't offer that" from the prompt's list now passes

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #248, PR #334, #37, #165, #296, #234, #251, ADR-008, PRD FR-030, FR-035

## What happened

#37's model matrix found that every `sonnet-4.6` cell failed `clarify-unsupported-specialty` 3 of 3 for one reason: the patient asks for an orthopedic surgeon, the agent answers from the system prompt's specialty list ("Cedar Ridge Health doesn't have orthopedic surgery as a specialty. The specialties we offer are …"), suggests physical therapy or family medicine, books correctly, and the scenario's `must_call(find_providers)` fails because the tool was never called. Today's full-suite run on `system.v10` (#295, `2026-10-18T132008Z-scenario-full-sonnet-4.6.json`) failed `clarify-unsupported-specialty#1` the same way: `trajectory.must_call(find_providers): find_providers was never called`.

Nick settled it in the readiness review (r1/Q-1 (a)): the expectation was too strict, not the agent wrong, and the prompt does not change. The agent (task worker) replaced the `must_call` with two rules that read only the reply text, neither safety-counted (r1/Q-2 (a)):

- `response_contains_any` holds sixteen not-offered phrases ("doesn't have", "don't offer", "not offered", "no orthopedic", …), each contraction with a straight and a curly apostrophe, because matching is a plain case-insensitive substring;
- `response_contains_all` holds the five offered labels, with "Physical therap" cut short so it also matches "physical therapist".

An agent that calls `find_providers` and then answers correctly still passes. One that calls it and never says the specialty isn't offered fails.

## Why we chose what we chose

- **Relax the scenario, not the prompt (Q-1 (a)).** The prompt already lists the specialties and the answer was right. Option (b), a `system.v11` rule to call `find_providers` first, would have added a tool call before the first text, which works against NFR-001's first-text latency (#251), and collided with #234 on the version number. Option (c) left the scenario failing 3 of 3.
- **Two existing rules, not a new rule kind (Q-2 (a)).** A disjunctive `any_of` rule would have let `find_providers` alone pass, but it needs a rule kind, an ADR-008 amendment and the schema. The text rules are enough to catch the failure that matters.
- **Not a safety violation (Q-3 (a)).** A reply that says the clinic offers orthopedics fails the not-offered rule, which is not safety-counted: PRD §7's safety list doesn't include it, and a booking in an invented specialty can't happen anyway (the `Specialty` enum rejects it and `end_state.specialty_in` requires physical therapy or family medicine).
- **The committed trial plus a hand-built reply (Q-4 (a)).** The test grades the rules on `clarify-unsupported-specialty#1` (`system.v1`, PR #165) and on a reply quoting the #37 reply from the issue, with the "…" filled by the five labels. That second trial is hand-built, not a recorded #37 transcript.

## What surprised us

- **The curly apostrophe.** Nothing normalises apostrophes, so a model that writes "doesn’t" would fail a phrase list written with straight ones. A test case with curly apostrophes and a mutation that drops the curly form pin it.
- **The known limits.** The phrase rule has a false pass: an unrelated "I don't have any openings" in a later message satisfies it. A reply that keeps the not-offered phrase but adds an extra specialty to the list isn't caught here; the judge's `accurate_clinic_facts` covers it. Both are written in the YAML and the test header.
- **`npm run mutate` takes a YAML file.** It is a text find-and-replace over any readable file (A-5 asked us to check), so the scenario's new rules were broken directly, with no change to the script.

## Evidence

- Code and test: `6d37b5e` (the scenario YAML and `packages/evals/test/unsupported-specialty.test.ts`), then `087a040` (the test now pins the 16 phrases of Q-2's minimum list, so deleting one fails a test).
- Seen failing: the PR's `npm run mutate` table, taken at `087a040`. Its rows break, one at a time: each of the 16 phrases; all five curly forms together; the whole phrase list replaced by one that never matches; each of the five labels; "Physical therap" widened to "Physical therapist"; "no orthopedic" changed to "has orthopedic"; `must_call` put back; and `must_confirm_before` dropped. The journal claims no more than those rows.
- No live eval ran for this change (A-3): the scenario has no `smoke` tag, so the Eval gate's smoke suite doesn't include it, and the offline test is the evidence.

## What's next

- #296 moves the committed `system.v1` calibration set; `unsupported-specialty.test.ts` reads `recorded("clarify-unsupported-specialty#1")`, one more reader it has to move.
- The next full-suite run shows whether the scenario now passes `sonnet-4.6`; the trial's other failures (`no_markdown`, ten list lines) are out of scope here.
