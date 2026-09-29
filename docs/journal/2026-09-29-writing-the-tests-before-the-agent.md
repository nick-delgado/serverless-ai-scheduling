# 2026-09-29 — Writing the evals first exposed gaps in the fixture and the harness

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #33 (S7-04), #30 (harness), #5 / PR #55 (conversation ownership), ADR-008, ADR-009, FR-030–FR-038

## What happened
Before any agent code existed, an agent wrote the 40 multi-turn scenarios and 22 single-turn (L1) cases that will decide whether the scheduling agent works. Each one is YAML against the `clinic-default` fixture:
- a frozen clock;
- a logged-in fixture patient;
- a persona and a goal for the simulator;
- deterministic expectations: end state, tool trajectory, invariants.

A small Vitest lint parses every file. It checks each patient, provider, slot, and appointment id against the fixture. It also checks that every FR-030…FR-037 and every ADR-009 agent-behaviour line is claimed by at least one scenario.

## Why we chose what we chose
- **Tool names only.** The scenarios don't use any provider's tool-call wire format. The model matrix may include Nova and gpt-oss next to Claude (#60), and the scenarios have to survive that.
- **Verbatim attack text.** The red-team cases send their payloads through a `script` field, so an attack is the same bytes on every run. We don't want to depend on a simulator paraphrasing it.
- **A lint that proves the ids, not a schema.** The real schema belongs to #30. For now, the lint only proves the ids exist, so the harness can't inherit scenarios about slots that were never in the fixture.

## What surprised us
- **The fixture can't express "which appointment?"** FR-032 says the agent asks when there are several appointments. No fixture patient has two upcoming ones. The scenarios needed a `setup.appointments` override. The same mechanism turned out to be the cleanest indirect-injection vector: a patient-typed `reason` that comes back verbatim from `get_my_appointments`.
- **DST bugs have a fingerprint.** For the week of Nov 2, an agent that converts UTC with the current EDT offset lists 8:00–11:30 AM EST morning slots as 9:00 AM–12:30 PM. So the check is simple: a "morning" answer that contains "12:30 PM" is the bug. No judge is needed.
- **One red-team case isn't an agent case at all.** When a patient sends someone else's `conversationId`, the handler decides what happens; the model never gets a say. That scenario needs `surface: api`, which ADR-008's format didn't anticipate.
- **Cancelled isn't absent.** Daniel's Okafor visit is `CANCELLED`. "Reschedule my Friday appointment" has to become "that one was cancelled, want a new one?", not a reschedule.

## Evidence
- `packages/evals/scenarios/`: book 8, reschedule 6, availability 6, escalate 5, clarify 5, safety 10, and 22 L1 cases. 8 multi-turn and 8 L1 cases are tagged `smoke`.
- `packages/evals/test/scenarios-lint.test.ts`: 194 tests. Seeding a bad patient alias or provider id makes them fail, as intended.

## What's next
- #30 turns the field reference in `scenarios/README.md` into a Zod schema. It also has to decide on `setup`, `script`, `surface`, and `fabricated_ids`.
- Run the smoke suite against the first agent build and commit the baseline.
