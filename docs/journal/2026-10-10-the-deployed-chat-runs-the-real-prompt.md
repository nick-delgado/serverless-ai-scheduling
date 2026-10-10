# 2026-10-10 — The deployed chat runs the real prompt, and the escalation alarm fires end to end

**Chapter:** 5. What the evals showed
**Milestone:** M3
**Related:** #36, #233, #35 (PR #131), #16 (PR #102), #29 (PR #231), #28 (PR #154), ADR-009, PRD FR-010–FR-037, PRD §5

## What happened

Until today the deployed `POST /api/chat` ran a short placeholder prompt and had no staff notifier. Every escalation on `dev` was stored as `FAILED`, and the patient got only the front-desk number. #36 assembled the streams. An agent (Claude, as #36's task worker) changed `services/api/src/handlers/chat.ts`:

- It now passes `buildSystemPrompt` (`system.v1`, #16) and the SES notifier from `sesNotifierFromEnv` (#35).
- It decorates `escalations.updateNotification`, so that every escalation stored `FAILED` for a reason the notifier never sees writes one `Sched/NotificationFailed` record: no notifier, a profile or transcript read that throws, or a notice that can't be built. A failed send is still recorded by the notifier alone, so a failure counts once (owner decision r1/Q-1 (a)).
- It deletes the placeholder prompt.

The agent then deployed the branch to `dev`:

- `scripts/deploy.sh api dev` at `a1e259f`, then `scripts/deploy-web.sh dev` at `dc2f63f` (the SPA hasn't changed since).
- A seed top-up: 720 new slots, a window from 2026-10-10, no `--reset`.

#99's checks still hold on the published site:

```
== /chat    HTTP/2 200 · content-type: text/html · cache-control: no-cache
== /login   HTTP/2 200 · content-type: text/html · cache-control: no-cache
== POST /api/chat (no token)   401
```

The agent ran the five intents as demo patient Maria Santos. It sent them to `POST /api/chat` with her ID token (an SRP sign-in from a scratch client) and read each end state from `sched-dev-main`. All five passed their pass conditions (r1/Q-2 (a)). Every stored turn trace records `promptVersion` `system.v1` on `sonnet-4.6`.

| Intent | What the agent said and did | End state in `dev` |
|---|---|---|
| Availability | "What openings does Dr. Lee have next week?" got five options, Monday October 12 from 8:00 to 10:00 AM ET, each with a weekday and an ET time | Read-only; all five fall inside the seeded 4 weeks |
| Book | Restated provider, Monday October 12 9:00 AM ET, 400 Cedar Ridge Pkwy and "Skin rash", then waited for "Yes, please book it." The reply named the date, time, provider and location | `prov_lee` 2026-10-12T13:00Z `BOOKED` |
| Reschedule | Found the seeded mole check (Tue October 13, 2:30 PM ET), offered five Thursday-afternoon times, restated the move and waited for a yes | Same `appointmentId`, now `slot_lee_20261015T1730Z` `BOOKED`; `slot_lee_20261013T1830Z` `OPEN` |
| Escalate | A billing question for a person got PRD §5's line with 1-800-555-0199 and Mon–Fri 8 AM–5 PM ET | Escalation `SENT` with a `messageId`; Nick received the email at the verified inbox |
| Emergency | "I have crushing chest pain and my left arm is numb…" got "Call 911 right now. Crushing chest pain with left arm numbness can be a sign of a heart attack and needs emergency care immediately — please do not wait." | No tool call in the turn |

Nick did the two browser checks on `dev` in **Chrome 154 on macOS**:

- **Voice turn (#29's real Transcriber):** he said "What openings does Dr. Lee have next week?". The final transcript filled the composer, was sent, and the agent replied.
- **#28's deferred overlay pass:** all five checks passed.
  - The level dot pulses with his voice.
  - Tab stays inside the overlay (Send ↔ Cancel).
  - Esc closes it and returns focus to the mic.
  - The overlay's spinner shows after Send.
  - The backdrop reads well in light and dark. He switched themes with DevTools' `prefers-color-scheme` emulation and the `data-theme` pin, since the page has no theme switch.

  The three pulsing dots after the overlay closes are the chat's typing indicator (#26), not part of this check.

The failure path needed an env whose staff send fails, which `dev` can't safely be (r1/Q-3 (b), r1/Q-4 (a)). The agent created `i36fail` with `SES_STAFF_RECIPIENT=front-desk-unverified@example.com scripts/deploy.sh all i36fail`, seeded it, and ran one escalation. The SES sandbox rejected the send, the patient still got the phone number, and the failure travelled all the way to the alarm (Evidence). Nick checked the alarm in the console, because the agent's role can't read alarm state. The orchestrating session then ran `scripts/teardown.sh i36fail --yes`. All four `sched-i36fail-*` stacks reached `DELETE_COMPLETE`, no `/sched/i36fail/` parameters remain, and the local Cognito mapping for the env was deleted.

## Why we chose what we chose

These are the decisions the spec left open. Nick's answers on the issue (Q-1 to Q-4, A-1 to A-9) settled the rest.

- **Where the handler learns of a FAILED notification.** It decorates `escalations.updateNotification` in `chat.ts` (A-3). The record is written only after the `FAILED` status is stored, and it uses the stored escalation's IDs. An update that throws or returns `null` writes none; reporting a failed write is #38's. The alternative was to write the record before the write, which would have needed the escalation ID from somewhere else and could have counted an escalation that was never stored.
- **The record's `errorName`.** It is the text before the first `: ` in the stored error (`RangeError`, `TypeError`, …), or `UnknownError` when there's none. It is `NotifierNotConfigured` when the env has no notifier, the name Q-1's edges give. The agent first wrote `NoNotifier`, then corrected it against the edges before deploying.
- **Skipping the notifier's own failures.** The handler skips a stored error that starts with `NotificationSendError:`, the prefix `notificationErrorText` gives a failed send. The prefix comes from the class's `name`, not a copied string. The alternative was to give `packages/tools` a hook, which Q-1 (c) priced and Nick didn't choose.
- **How the decorator delegates.** It spreads the escalation repo and replaces one method. Both repo implementations, in-memory and DynamoDB, are plain objects of closures, so a spread copy keeps working. Hand-written delegates for `record` and `getForConversation` added lines no test reached.
- **The run-through channel.** The agent ran the intents through `POST /api/chat` with the patient's ID token, not the SPA, because it has no browser (Q-2 (a) allows either). The voice turn and the overlay pass needed Nick's hands and got them.
- **One stale-looking line left alone.** `packages/tools/src/notify/index.ts:6` says "the chat handler wires it (#36)". That is true now, so it stays (A-5 listed it as possibly stale).

## What surprised us

- **The real prompt let Markdown back in.** The placeholder said "Keep replies short and plain (no markdown)". `system.v1` says nothing about formatting, and on `dev` the booking confirmation came back as `- **Provider:** Dr. Priya Lee (Dermatology)`. The handoff once came back as `Please call **1-800-555-0199**`. The chat bubble renders plain text (`white-space: pre-wrap`), so the patient sees the asterisks. Text the model writes before a tool call also streams into the answer. On the `dev` escalation, the patient read "I'll connect you with our front desk right away, Maria." and then "I'll connect you with our front desk. Please call…". None of this broke a pass condition, and the evals never render a bubble, so they couldn't see it. Filed as #233.
- **What the patient hears when the email didn't go out.** On `i36fail` the agent replied:

  > "I'll connect you with our front desk. Please call 1-800-555-0199 (Mon–Fri, 8 AM–5 PM ET). I've passed a summary of our conversation to them.
  >
  > Is there anything else I can help you with in the meantime?"

  That is PRD §5's escalation message word for word. It never promises an email or a callback, so under Q-3 (b) nothing was filed. "I've passed a summary of our conversation to them" is PRD §5's own wording. It holds because the summary is stored with the escalation and, as here, a failed send raises the alarm and is re-sent by staff tooling (#35). We record it as observed.
- **The EMF line survives Lambda's JSON log format.** That was the open risk from PR #131. Lambda passed the raw `process.stdout` line through unwrapped, and CloudWatch extracted the metric from it.
- **The deploy role can read the metric but not the alarm.** `SchedDeployer` may call `GetMetricData`, but not `DescribeAlarms` or `DescribeAlarmHistory`. The alarm's state took a human with the console.

## Evidence

- **Tests:** `services/api/test/chat-handler.test.ts` has one test per Q-1 path:
  - `SENT`: no record;
  - a failed send: the notifier's record only;
  - no notifier: `NotifierNotConfigured`;
  - a profile read, a transcript read or a notice build that throws: one record, with the thrown error's name;
  - a non-`Error` rejection: `UnknownError`;
  - `already_escalated`: no second record;
  - a `null` update: no record.

  It also covers the prompt version, the cold-start failures (no `SCHED_ENV`, half-set SES) and the SES send. In `npm run mutate`, all 17 behavioural edits were KILLED by the test their `expect` named, and 2 type-level edits by `tsc` (the PR has both tables).
- **Bundle (A-8):** `make -f services/api/Makefile build-ChatFunction` produces an `index.mjs` that contains `SendEmailCommand` and `system.v1`. No `package.json` change was needed.
- **Failed send on `i36fail`:**
  - The stored error: `NotificationSendError: MessageRejected: Email address is not verified. The following identities failed the check in region US-EAST-1: <address>` (the notifier redacts the address).
  - The one matching line in `/aws/lambda/sched-i36fail-api-chat`. The handler wrote no second record:

    ```
    {"_aws":{"Timestamp":1791641672591,"CloudWatchMetrics":[{"Namespace":"Sched","Dimensions":[["Env"]],"Metrics":[{"Name":"NotificationFailed","Unit":"Count"}]}]},"Env":"i36fail","NotificationFailed":1,"escalationId":"esc_ffb201ad69604e5a89ac71dbf60178c3","conversationId":"c5beb545-fae6-456d-97c8-577e3588c00c","errorName":"MessageRejected"}
    ```

  - The datapoint: `GetMetricData` for `Sched/NotificationFailed` with `Env=i36fail` gives Sum `1.0` at 2026-10-10T14:14Z.
  - The alarm: `sched-i36fail-notification-failed` went to `ALARM`, as Nick saw in the console.
- **Live spend:** 9 agent turns on `sonnet-4.6` across `dev` and `i36fail`. Tokens: 37 input, 2,441 output, 95,240 cache read, 17,216 cache write. That is about $0.13 at list prices. No eval run: the prompt text, the agent loop, the tools and the model config didn't change, and the eval harness already ran `buildSystemPrompt` (A-4).

## What's next

- #233: plain-text replies, and one handoff line per escalation.
- #38 puts `Sched/NotificationFailed` on a dashboard, and reports a failed `updateNotification` write.
- #40 takes the browser matrix for text and voice.
