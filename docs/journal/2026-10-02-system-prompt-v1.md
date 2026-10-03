# 2026-10-02 — System prompt v1: Sonnet goes to 66 of 66, and Nova Pro shows what a prompt can't fix

**Chapter:** 4. Teaching the agent to schedule
**Milestone:** M2
**Related:** issue #16 (S3-02), PRD §5 and FR-030–FR-037, ADR-001 (prompt caching), ADR-009, ADR-010, [first live L1 run](2026-09-29-first-live-l1-run.md), #88, #31

## What happened

An agent wrote the production system prompt, `packages/agent/src/prompts/system.v1.ts`, and switched the eval harness from the S-1 draft (`eval-interim.v0`) to it. On the 22 L1 cases with Sonnet 4.6, the draft passed 19. Two of the failures were implicit escalations, billing and cancel-only, where the model answered in prose and never called `escalate_to_human`. The third was two questions in one message. v1 passes all 22, and it passed all 66 trials of a three-trial run.

The first v1 draft fixed those three and broke a case that had passed before. Asked to "book me in with my usual doctor", Sonnet replied "Let me pull up your profile… and what's the reason for your visit?" and called no tool. The prompt said to ask for the reason before booking, and the model asked instead of looking the doctor up. Two rules fixed it: look up what a tool can find first, in the same reply, and never say you will check something unless you call the tool in that reply.

## Why we chose what we chose

The spec left these open.

- **Out of scope splits in two.** Clinic business that only staff can do (billing, cancelling without rebooking, refills, results, records, referrals) calls `escalate_to_human` with `out_of_scope` in the same reply, without asking first. Requests that have nothing to do with the clinic, like the banana-bread recipe, get a decline and no escalation. Asking for another patient's data is declined and isn't escalated on its own. The draft had one "out of scope" bucket, and the models handled it differently each time.
- **The escalation message drops the email promise.** PRD §5 says "I've also sent them a summary of our conversation so you won't have to repeat yourself." Since #88 a failed staff email is retried out of band, so v1 says "I've passed a summary of our conversation to them" and may only say it after the tool succeeded. The PRD text still needs the same edit.
- **The context block after the cache breakpoint carries the date, not the time.** Today's date, its weekday, every weekday of this week and next week with ISO dates, the timezone, and the first name. With no clock time in it, it stays identical all day, so the rolling cache point on the conversation keeps hitting from turn to turn. "Next week" is Monday to Friday of the following week, and "next Friday" is next week's Friday.
- **The first name is profile data, and it's treated as untrusted.** It's cut to one line of 40 characters with control and format characters removed. When it's missing, the prompt says it isn't known, instead of the harness's old "there".
- **A short "Rules you never break" list comes first.** It repeats the confirmation, invented-times, ID and plain-text rules from the sections below. Sonnet didn't need it. Nova Pro did.

## What surprised us

- **One trial lied about Nova Pro.** A single-trial run of v1 on Nova Pro passed 22 of 22. The three-trial run of the same prompt passed 14, with 6 safety violations. Three of them were bookings straight after the patient picked a slot and gave the reason, with no restatement. After the "never break" list, bookings without confirmation went to zero across the later runs. Nova Pro's last three-trial run is pass@1 86% with 3 safety violations in 66 trials:
  - it put a patient-supplied UUID into an escalation summary;
  - it twice leaked a `<thinking>` block into the visible text.

  Nova still answers billing and failed-booking cases in prose about a third to all of the time. Once it even wrote the handoff message without calling the tool, which is why v1 now forbids saying it unless the tool succeeded.
- **A fixed rule can move a failure to another model.** The "look it up first" rule fixed Sonnet. Nova Pro then called `get_patient_profile` on "I need to make an appointment", even though the first name was already in the prompt.

## Evidence

| Run (L1 full, 22 cases) | Prompt | Trials | Passed | pass@1 | Tool-call acc. | Safety | Cost |
|---|---|---|---|---|---|---|---|
| Sonnet 4.6, baseline on `main` | eval-interim.v0 | 1 | 19 / 22 | 86% | 91% | 0 | $0.11 |
| Sonnet 4.6, first draft | system.v1 (draft) | 1 | 21 / 22 | 95% | 95% | 0 | $0.12 |
| Sonnet 4.6, final | system.v1 | 3 | 22 / 22 (66 / 66 trials) | 100% | 100% | 0 | $0.37 |
| Nova Pro, 2026-09-29 | eval-interim.v0 | 1 | 16 / 22 | 73% | 77% | 0 | $0.02 |
| Nova Pro, mid-iteration | system.v1 (draft) | 3 | 14 / 22 | 83% | 88% | 6 | $0.10 |
| Nova Pro, final | system.v1 | 3 | 17 / 22 | 86% | 88% | 3 | $0.10 |

- Command: `npm run evals -- --suite full --mode l1 --profile <name> --trials <n>`. List prices as of 2026-09-29. Total Bedrock spend for the issue, all iterations: about $2.39.
- Prompt tests: `packages/agent/src/prompts/system.v1.test.ts`. One test checks that every scenario id in the prompt's policy table names a real scenario file. Each test was watched failing against a deliberate break: a name in the stable prefix, UTC dates, Sunday-based weeks, no name cleaning, a bogus id, the email promise, a renamed version, and an XML tag.

## What's next

- #36: wire `buildSystemPrompt` into the chat handler with the profile's first name.
- PRD §5: change the escalation message to the v1 wording.
- M3 model matrix: on Nova Pro, the prompt alone doesn't reach the safety bar. Stripping `<thinking>` in the loop and a guard against IDs in escalation summaries are candidates, and they'd be decided by data.
- Scenario mode with the simulator (#31) is the next real test of the one-question and five-option rules across a whole conversation.
