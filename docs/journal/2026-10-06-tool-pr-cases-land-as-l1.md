# 2026-10-06 — Ten cases the tool PRs asked for land as L1, and the API-surface case retires to the handler's tests

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** #80, #201, ADR-008 (amendment of 2026-10-03), PRD FR-030 to FR-034, FR-037

## What happened

Every tool PR (#66, #68, #69, #70, #93, #102) found a model behaviour its unit tests couldn't reach and listed it on #80 as an eval case to write. The agent on #80 wrote ten of them as single-turn (L1) cases under `packages/evals/scenarios/l1/`, dropped one with a reason, and synced the canned error in an eleventh, older case to what `book_appointment` really says. The new cases cover past appointments, a cancelled Friday visit, looking a provider up by name, a search for a date that has passed, a second request for a person after an escalation, idempotent retries of a booking and a reschedule, a booking refused because its time has started, a booking refused because the panel is closed to new patients, and an established patient asking for a closed-panel doctor. None is tagged `smoke`, so #34's gate doesn't move.

The same PR retired `safety-conversation-id-ownership` to L0, as the ADR-008 amendment of 2026-10-03 decided. A scenario now takes an optional `covered_by` path. A run makes no model call for it and reports it as `skip` with "covered outside the harness: services/api/test/chat-turn.test.ts", where the old skip still said it needed the chat handler from #17, which has since shipped. The `conversation_owned_by_caller` invariant's skip reason points at the same file.

#80 closes with this PR, so the agent filed #201 as the home for cases that later PRs suggest, and pointed the `add-agent-tool` skill and the backlog map at it (Nick's decision r1/Q-7 (a)).

## Why we chose what we chose

Nick settled the shape of most cases before work started (readiness round 1 on #80). These are the calls the agent made where the spec left room:

- **Notifier failure: dropped.** The handler test "still records the escalation and returns the phone and hours when the notifier throws" (`packages/tools/test/tools/escalate_to_human.test.ts`) covers it, and since #88 the model sees the same output whether the email went out or not, so no eval can tell the two apart (r1/Q-2 (a)).
- **The idempotent-retry cases check the time by its parts.** r1/A-9 asks for `response.contains_all` with the result's `start_local`. The literal string ("Thursday, October 15, 2026 at 2:00 PM ET") would fail a reply that follows the system prompt's own example, which drops the year ("Tuesday, October 13 at 2:30 PM ET"). So the cases check `["Thursday", "October 15", "2:00 PM"]` and `["Wednesday", "October 14", "3:00 PM"]`, as `availability-my-next-appointment` already does. The literal string would have been a wrong check, not a stricter one.
- **The already-booked case declares its appointment in `setup`.** The retry's result names an appointment that isn't in the fixture, and the lint rejects undeclared ids. `setup.appointments` holds it, on the slot the result names.
- **The past-slot case puts the clock at 10:02 AM.** The patient confirmed the 10:00 AM slot before it started, and the booking call landed after, which is the race the handler's `NOT_ALLOWED` guards against.
- **The "last Friday" case adds two context lines.** "Anything last Friday?" alone doesn't say what kind of visit, so a dermatology request and a "which days work?" come first. The check is r1/Q-4 (a)'s: a reply, or a search starting on a date from Oct 5 to Nov 6.
- **`covered_by` lives on `Scenario` only, and the lint checks the path exists.** An L1 case never skips, so the field would mean nothing there; the schema rejects it on an L1 case. The fallback skip for a `surface: api` scenario without `covered_by` stays, without the stale "#17".
- **The successor issue sits in M3 as `status:backlog`.** It has no cases yet, and #80's own milestone (M2) is closing.
- **The synced `l1-slot-taken-offer-alternatives` wasn't run live.** The approved run covers the new ids; its next full L1 run will show whether the real message changes anything.

## What surprised us

How stale the old skip had become. The scenario said it needed a chat handler that #17 had already shipped, while the handler's own tests had covered the foreign `conversationId` since then. A skip reason is a claim too, and nothing checked it.

## Evidence

- Seen failing: 8 mutate edits across `runner.ts`, `schema.ts`, `invariants.ts` and the ownership scenario, 8 killed (table in the PR).
- `npm run evals -- --suite full --mode scenario --trials 1 --filter safety-conversation-id-ownership`: estimate $0.0000, 0 runnable; the row reads `| safety-conversation-id-ownership | skip | – | covered outside the harness: services/api/test/chat-turn.test.ts |`.
- First `sonnet-4.6` run of the ten new L1 cases: dry-run estimate $0.1941. Results: pending (see the PR).

## What's next

- The first `sonnet-4.6` results for the ten cases, and a recommendation on whether `check_availability`'s description should say "dates must be today or later".
- A drift guard that compares every canned tool error in `scenarios/l1/` with the handler's message (r1/A-8 listed it as a follow-up).
- The policy-to-scenario table in `packages/agent/src/prompts/system.v1.ts` doesn't list the new cases yet (r1/A-12).
